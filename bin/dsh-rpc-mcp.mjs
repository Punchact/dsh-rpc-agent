#!/usr/bin/env node
// MCP (Model Context Protocol) stdio bridge for @punchact/dsh-rpc-agent.
//
// Point any MCP-capable agent at this script and it gains a `dsh_ask` tool that
// hands the task to DeepSeek Harness — a full agent with its own tools, skills,
// MCP servers and sandbox — then returns the answer.
//
//   Claude Code : claude mcp add dsh -- node "<path>/bin/dsh-rpc-mcp.mjs"
//   Cursor/Codex: {"mcpServers":{"dsh":{"command":"node","args":["<path>/bin/dsh-rpc-mcp.mjs"]}}}
//
// stdout carries protocol frames only; every diagnostic goes to stderr.

import { rpcCall, waitForTurn, WAIT_SLICE_MS } from "../lib/client.mjs";
import { PLUGIN_VERSION } from "../lib/version.mjs";
import { formatToolResult, formatToolError } from "../lib/mcp-format.mjs";
import { createInflight } from "../lib/inflight.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "dsh-rpc", version: PLUGIN_VERSION, title: "DeepSeek Harness bridge" };

// The sticky-session namespace. Two agents pointed at the same directory must not
// share a session, so the client's own name (sent in `initialize`) becomes part of
// the registry key. `mcp` is the fallback for clients that send no `clientInfo`.
let clientNamespace = "mcp";

const TOOLS = [
  {
    name: "dsh_ask",
    title: "Ask DeepSeek Harness",
    description:
      "Delegate a task to DeepSeek Harness, a full agent with its own file tools, shell, skills and MCP servers, and return its answer. " +
      "The Harness works in its own process and session; it does not share this agent's context, so make the prompt self-contained. " +
      "Sessions are STICKY: name the same `project` (or `cwd`) on the next call and the same session is reused — do not pass session_id " +
      "unless you are deliberately continuing a session the registry does not know about. " +
      "wait defaults to false: the call returns a handle (session_id + request_id) in milliseconds, and you collect the answer with " +
      'dsh_wait. Pass wait:true only when the task is known to finish quickly. The answer line starts with "outcome:" — read that, not ' +
      "the tool error flag, to learn what happened. A turn that is still running is NOT a failure: collect it with dsh_wait and never " +
      "resend the prompt.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained task or question for the Harness agent." },
        project: {
          type: "string",
          description:
            "Sticky-session scope: any stable label for the work (a repo name, a ticket id). The next call with the same project — from " +
            "this client — reuses the session it created. Falls back to `cwd` when omitted.",
        },
        reuse: {
          type: "string",
          enum: ["auto", "never", "latest"],
          default: "auto",
          description:
            'auto (default) reuses the session recorded for this project; never always creates a fresh session; latest ignores the ' +
            "recorded session id and takes the most recently updated session for the project.",
        },
        mode: {
          type: "string",
          enum: ["turn", "steer", "queue"],
          default: "turn",
          description:
            'turn (default) delivers only into an idle session and fails with a busy error if one is running; steer injects into the ' +
            'running turn; queue waits for it. A busy error is not a failure — follow the running turn with dsh_wait instead.',
        },
        wait: {
          type: "boolean",
          default: false,
          description:
            "false (default) returns a handle immediately: use dsh_wait to collect the result. true blocks until the turn finishes " +
            "and returns its answer in the same call — only when the work is known to be short.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for a new session, and the fallback sticky scope when `project` is omitted. Defaults to the Harness " +
            "default. Exclusive with workspace_id. Refused when session_id is given — where a session lives is fixed at creation.",
        },
        workspace_id: {
          type: "string",
          description:
            "Put a new session in one of the Harness workspaces (see dsh_workspaces). Exclusive with cwd. Refused when session_id is given.",
        },
        session_id: { type: "string", description: "Continue an existing Harness session instead of creating one." },
        queue: {
          type: "boolean",
          description:
            "Wait for the session when another caller is already prompting it, instead of failing with a busy error. Bounded by timeout_ms.",
        },
        agent_preset: {
          type: "string",
          description: "Agent preset for a new session (e.g. standard, minimal, cordis). Refused when session_id is given.",
        },
        model: {
          type: "string",
          description:
            "Model for the next turn, as 'provider/model' or a bare id when only one provider offers it. Like switching models in the GUI, this also becomes the profile default.",
        },
        reasoning_effort: { type: "string", description: "Reasoning effort id; requires model in the same call." },
        permission: {
          type: "string",
          description:
            "Permission preset for the session (see dsh_permissions). Each preset expands to a sandbox mode plus an approval policy. " +
            "Omit it by default. If a result comes back with `sandbox.denied: true` — or the Harness reports that a write was blocked — " +
            'retry ONCE in the same session with permission: "danger-full-access": that preset is full disk access with approvals ' +
            "disabled. Do not retry the same preset, and do not open a new session to get around a permission wall.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 3600000,
          description: "How long to wait for the turn to finish. Defaults to the bridge's configured value (600000).",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_workspaces",
    title: "List Harness workspaces",
    description:
      "List the workspaces the Harness shows in its sidebar: id, title, directory and whether the directory still exists. Pass a title with a path to register a new one.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute directory to register as a workspace. Omit to list only." },
        title: { type: "string", description: "Display title used when registering a new workspace." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dsh_permissions",
    title: "List Harness permission presets",
    description:
      "List the permission presets this Harness deployment offers, with the default marked. A preset is a sandbox mode plus an approval policy; " +
      "each entry carries a `cost` sentence, because the deployment's own descriptions are often empty. " +
      'Start with the default. Use "danger-full-access" only after a turn was actually blocked by the sandbox, and say so in your answer.',
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "dsh_sessions",
    title: "List Harness sessions",
    description:
      "List DeepSeek Harness sessions with their id, working directory, and running/blank state. Use it to find the session a sticky " +
      "project already has, or to check whether a turn is still running before resending anything.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Maximum sessions to return (default 50)." },
        cwd: {
          type: "string",
          description: "Only sessions at or under this directory (prefix match). Use it to see one project's sessions.",
        },
        sort: {
          type: "string",
          enum: ["updatedAt", "createdAt"],
          description: "Newest first by this field (default updatedAt).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dsh_wait",
    title: "Wait for a Harness turn",
    description:
      "Block until the turn currently running on a session finishes, then return its text. This is the supported way to collect work after " +
      "a timeout or after dsh_ask with wait:false — do not resend the prompt. Pass the `since` cursor from the previous answer to get only " +
      "what happened afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session to wait on." },
        since: {
          type: "integer",
          minimum: 0,
          description:
            "Return only what happened after this cursor (the `cursor` value from a previous result). Omit for the whole turn.",
        },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 3600000 },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_cancel",
    title: "Cancel a Harness turn",
    description: "Cancel the in-flight turn of a session so a long or runaway task stops.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string", description: "Session whose turn should be cancelled." } },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_status",
    title: "Harness bridge status",
    description: "Report the bridge version, mounted endpoint, token source and any active runs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// --------------------------------------------------------------- transport --

let buffer = "";
let pending = 0;
// One controller per in-flight client request, so `notifications/cancelled` has
// something to abort. The registry remembers which controller it registered per
// id: a client may reuse an id once its request finished, and a late completion
// must not evict the controller of the request that took the id over.
const inflight = createInflight();
let closing = false;

// Requests are answered concurrently, so end-of-input must not tear the process
// down while a `dsh_ask` is still waiting on a Harness turn.
function track(work) {
  pending += 1;
  // `finally` alone would hand back a rejected promise nobody awaits, and an
  // unhandled rejection kills the process — catch first, then settle.
  work
    .catch((error) => log(`unhandled: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      pending -= 1;
      if (closing && pending === 0) process.exit(0);
    });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) track(handleLine(line));
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  closing = true;
  if (pending === 0) process.exit(0);
});

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: "2.0", id, error });
}

function log(message) {
  process.stderr.write(`[dsh-rpc-mcp] ${message}\n`);
}

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    replyError(null, -32700, "invalid JSON");
    return;
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    replyError(null, -32600, "invalid request");
    return;
  }
  const isNotification = !("id" in request);
  const id = request.id ?? null;
  const method = typeof request.method === "string" ? request.method : "";

  try {
    switch (method) {
      case "initialize":
        {
          const name = request.params?.clientInfo?.name;
          if (typeof name === "string" && name.trim()) clientNamespace = name.trim();
        }
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Use dsh_ask to delegate a self-contained task to DeepSeek Harness and get its answer back. " +
            "Harness runs as an independent agent with its own tools and session; it cannot see this conversation. " +
            "Sessions are sticky per project: pass `project` (or `cwd`) and the next call with the same project reuses that session.",
        });
        return;

      case "notifications/initialized":
        return;

      case "notifications/cancelled": {
        const target = request.params?.requestId ?? request.params?.id ?? null;
        if (target !== null && inflight.cancel(target)) {
          log(`cancelled by the client: ${String(target)}`);
        }
        return;
      }

      case "ping":
        if (!isNotification) reply(id, {});
        return;

      case "tools/list":
        reply(id, { tools: TOOLS });
        return;

      case "tools/call": {
        const params = request.params ?? {};
        const name = params.name;
        const args = params.arguments ?? {};
        const controller = new AbortController();
        if (id !== null) inflight.begin(id, controller);
        let outcome;
        try {
          outcome = await callTool(name, args, controller.signal);
        } finally {
          if (id !== null) inflight.settle(id, controller);
        }
        // A notification carries no id and must never be answered.
        if (!isNotification) reply(id, outcome);
        return;
      }

      case "resources/list":
        reply(id, { resources: [] });
        return;

      case "prompts/list":
        reply(id, { prompts: [] });
        return;

      default:
        if (!isNotification) replyError(id, -32601, `unknown method: ${method}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`error in ${method}: ${message}`);
    if (!isNotification) {
      replyError(id, -32603, message, error?.data);
    }
  }
}

// ------------------------------------------------------------------- tools --

const DEFAULT_TURN_TIMEOUT_MS = 600000;

/** Out-wait the server's turn budget so the bridge never aborts a live turn. */
function turnBudget(timeoutMs) {
  return (Number.isInteger(timeoutMs) ? timeoutMs : DEFAULT_TURN_TIMEOUT_MS) + 30_000;
}

// The bridge may configure other budgets than these literals. Ask it once, then
// quote its answer in hints and use it as the default turn budget — a hint that
// names 600000 against a 10-minute deployment is exactly the drift the audit
// flagged.
let bridgeDefaults = null;

async function bridgeSettings() {
  if (bridgeDefaults !== null) return bridgeDefaults;
  try {
    const info = await rpcCall("dsh.discover", {}, { timeoutMs: 5_000 });
    bridgeDefaults = { ...(info?.config ?? {}) };
  } catch {
    // A bridge that cannot answer now will fail the real call with a better
    // message; the literal default keeps the hint usable meanwhile.
    bridgeDefaults = {};
  }
  return bridgeDefaults;
}

async function callTool(name, args, signal = undefined) {
  // Cancellation from the client has to reach the request that is still in flight;
  // these two wrappers are the only places that talk to the bridge from here.
  const call = (method, params, options = {}) => rpcCall(method, params, signal ? { ...options, signal } : options);
  const waitTurn = (sessionId, options = {}) => waitForTurn(sessionId, signal ? { ...options, signal } : options);
  try {
    const defaults = await bridgeSettings();
    const turnDefault = Number.isInteger(defaults.defaultTimeoutMs) ? defaults.defaultTimeoutMs : DEFAULT_TURN_TIMEOUT_MS;
    const hintOptions = { defaultTimeoutMs: turnDefault };
    switch (name) {
      case "dsh_ask": {
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        if (prompt.trim().length === 0) {
          return formatToolError("`prompt` is required", undefined, "pass the task as a self-contained prompt string");
        }
        const params = { text: prompt };
        const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
        if (sessionId) params.sessionId = sessionId;
        // Location and preset are creation-only. They are forwarded even when a
        // session was named so the bridge can refuse the contradiction — dropping
        // them here would look like they had been honoured.
        if (typeof args.cwd === "string" && args.cwd.trim()) params.cwd = args.cwd.trim();
        if (typeof args.workspace_id === "string" && args.workspace_id.trim()) {
          params.workspaceId = args.workspace_id.trim();
        }
        if (typeof args.agent_preset === "string" && args.agent_preset.trim()) {
          params.agentPreset = args.agent_preset.trim();
        }
        if (typeof args.model === "string" && args.model.trim()) params.model = args.model.trim();
        if (typeof args.reasoning_effort === "string" && args.reasoning_effort.trim()) {
          params.reasoningEffort = args.reasoning_effort.trim();
        }
        if (typeof args.permission === "string" && args.permission.trim()) {
          params.permissionPreset = args.permission.trim();
        }
        if (args.queue === true) params.queue = true;
        // 0.5.0: the handle shape is the default. Blocking is the opt-in, because a
        // caller whose own tool budget is 300 s cannot finish a 10-minute turn and
        // the timeout then looks like a failure that invites a resend.
        if (args.wait !== true) params.wait = false;
        if (Number.isInteger(args.timeout_ms)) params.timeoutMs = args.timeout_ms;
        if (typeof args.project === "string" && args.project.trim()) params.project = args.project.trim();
        if (typeof args.reuse === "string" && args.reuse.trim()) params.reuse = args.reuse.trim();
        if (typeof args.mode === "string" && args.mode.trim()) params.mode = args.mode.trim();
        // The sticky registry is namespaced per client so two agents that happen to
        // work in the same directory do not inherit each other's session.
        params.namespace = clientNamespace;

        if (params.wait === false) {
          const result = await call("dsh.sessions.ask", params, { timeoutMs: turnBudget(args.timeout_ms ?? turnDefault) });
          return formatToolResult(result, hintOptions);
        }
        // Blocking: ask for one slice, then keep waiting in slices. A single
        // request that stayed quiet past ~300 s would be cut by the transport.
        const timeoutMs = Number.isInteger(args.timeout_ms) ? args.timeout_ms : turnDefault;
        const slice = Math.min(timeoutMs, WAIT_SLICE_MS);
        const first = await call(
          "dsh.sessions.ask",
          { ...params, timeoutMs: slice },
          { timeoutMs: Math.min(slice + 30_000, 280_000) },
        );
        if (first?.status === "timeout" && typeof first.sessionId === "string") {
          const left = timeoutMs - (first.durationMs ?? slice);
          if (left > 1_000) {
            const waited = await waitTurn(first.sessionId, { timeoutMs: left });
            return formatToolResult({
              ...first,
              ...waited,
              text: waited.text || first.text,
              tools: waited.tools?.length > 0 ? waited.tools : first.tools,
              durationMs: (first.durationMs ?? 0) + (waited.waitedMs ?? 0),
            }, hintOptions);
          }
        }
        return formatToolResult(first, hintOptions);
      }

      case "dsh_workspaces": {
        const path = typeof args.path === "string" ? args.path.trim() : "";
        if (path) {
          const title = typeof args.title === "string" ? args.title.trim() : "";
          const created = await call("dsh.workspaces.create", title ? { path, title } : { path });
          return {
            content: [{ type: "text", text: `workspace ${created.id}  ${created.title}\n${created.path}` }],
          };
        }
        const result = await call("dsh.workspaces.list", {});
        const lines = (result.items ?? []).map(
          (item) => `${item.id}  ${item.title}  [${item.status}, ${item.sessions} sessions]\n  ${item.path}`,
        );
        return {
          content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "(no workspaces registered)" }],
        };
      }

      case "dsh_permissions": {
        const result = await call("dsh.permissions.catalog", {});
        const lines = (result.options ?? []).map((option) => {
          const mark = option.value === result.defaultPreset ? "*" : " ";
          return `${mark} ${option.value}  ${option.name}${option.description ? ` — ${option.description}` : ""}`;
        });
        return {
          content: [
            {
              type: "text",
              text: lines.length > 0 ? lines.join("\n") : "(this deployment exposes no permission presets)",
            },
          ],
        };
      }

      case "dsh_sessions": {
        const params = {};
        if (Number.isInteger(args.limit)) params.limit = args.limit;
        if (typeof args.cwd === "string" && args.cwd.trim()) params.cwd = args.cwd.trim();
        if (typeof args.sort === "string" && args.sort.trim()) params.sort = args.sort.trim();
        const result = await call("dsh.sessions.list", params);
        const lines = (result.items ?? []).map(
          (item) =>
            `${item.sessionId}  ${item.running ? "running" : "idle"}${item.blank ? ",blank" : ""}  ${item.cwd ?? ""}`,
        );
        return { content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "(no sessions)" }] };
      }

      case "dsh_wait": {
        const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
        if (!sessionId) return formatToolError("`session_id` is required", undefined, "call dsh_sessions() to find the session id");
        // Sliced on purpose: see waitTurn(). One long request cannot survive
        // the transport's 300 s ceiling, and the answer would be lost with it.
        const result = await waitTurn(sessionId, {
          timeoutMs: Number.isInteger(args.timeout_ms) ? args.timeout_ms : turnDefault,
          since: Number.isInteger(args.since) ? args.since : undefined,
        });
        return formatToolResult(result, hintOptions);
      }

      case "dsh_cancel": {
        const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
        if (!sessionId) return formatToolError("`session_id` is required", undefined, "call dsh_sessions() to find the session id");
        const result = await call("dsh.sessions.cancel", { sessionId });
        return { content: [{ type: "text", text: `cancelled ${result.sessionId}` }] };
      }

      case "dsh_status": {
        const result = await call("dsh.ping", {});
        const text = [
          `plugin: ${result.plugin} ${result.version}`,
          `endpoint: ${result.origin ?? "?"}${result.config?.path ?? ""}`,
          `token source: ${result.state?.tokenSource}`,
          `active runs: ${result.activeRuns?.length ?? 0}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }

      default:
        return formatToolError(`unknown tool: ${name}`, undefined, "call tools/list for the supported names");
    }
  } catch (error) {
    // `code` is the JSON-RPC code the bridge answered with; toolError turns it
    // into the concrete next step instead of leaving the caller to guess.
    return formatToolError(error instanceof Error ? error.message : String(error), error?.data, error?.code);
  }
}


log(`ready (${SERVER_INFO.name} ${SERVER_INFO.version})`);
