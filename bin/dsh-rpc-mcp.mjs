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
// Task-center note: `dsh.tasks.reconcile` and `dsh.tasks.decideApproval` are
// intentionally NOT exposed as MCP tools — both require human operator judgment
// and must only be invoked through the operator CLI (`bin/dsh-rpc.mjs`) or RPC.
//
// stdout carries protocol frames only; every diagnostic goes to stderr.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rpcCall, waitForTurn, WAIT_SLICE_MS } from "../lib/client.mjs";
import { sanitizeAdapterFailure } from "../lib/adapters/base.mjs";
import { PLUGIN_VERSION } from "../lib/version.mjs";
import { capText, formatToolResult, formatToolError } from "../lib/mcp-format.mjs";
import { createInflight } from "../lib/inflight.mjs";
import { normalizeTraceLevel } from "../lib/trace-format.mjs";
import { DEFAULT_HISTORY_KINDS, formatHistory } from "../lib/history-format.mjs";
import { formatCapabilities } from "../lib/capabilities.mjs";
import { TIMEOUT_ADVICE, shouldAdviseTimeout } from "../lib/advice.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "dsh-rpc", version: PLUGIN_VERSION, title: "DeepSeek Harness bridge" };

// The sticky-session namespace. Two agents pointed at the same directory must not
// share a session, so the client's own name (sent in `initialize`) becomes part of
// the registry key. `mcp` is the fallback for clients that send no `clientInfo`.
let clientNamespace = "mcp";

const BASE_TOOLS = [
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
      "resend the prompt. Use dsh_history to inspect what tools and events actually ran in a session (read-only).",
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
            "the decision whether this session may run wider is yours: retry ONCE in the same session with permission: " +
            '\"danger-full-access\" only after deciding that, and say so in your answer. Do not retry the same preset, ' +
            "and do not open a new session to get around a permission wall. With approvals.mode=delegate the escalation is " +
            "held before the tool runs: answer it with dsh_approvals_pending / dsh_approvals_resolve instead of re-asking.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 3600000,
          description:
            "How long to wait for the turn to finish. Defaults to the bridge's configured value (600000)." +
            " Outer MCP clients usually cap a single tool call below this maximum (Codex: tool_timeout_sec, 900 s by default);" +
            " the bridge cannot raise that cap, so for long work pass wait:false and poll with dsh_wait.",
        },
        trace: {
          type: "string",
          enum: ["none", "errors", "summary", "full"],
          description:
            "How much tool-call trace to render alongside the answer. Defaults to the bridge's traceDefault (errors). 'none' restores the pre-0.8.1 output.",
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
      'Start with the default. Use "danger-full-access" only after deciding that a session which was actually blocked by the sandbox may run wider, and say so in your answer.',
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "dsh_approvals_pending",
    title: "See sandbox escalations waiting for you",
    description:
      "List the sandbox escalations a Harness session is holding for your decision. Only sessions this MCP server created ask here, and only when " +
      'the bridge runs with approvals.mode="delegate". Each item carries the exact command (argv), the working directory, the requested mode and the ' +
      "agent's stated reason. Pass wait_ms to wait in one call instead of polling; an unanswered request is refused when its deadline passes.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Only this session's pending requests." },
        wait_ms: {
          type: "integer",
          minimum: 0,
          maximum: 120000,
          description: "Long-poll: return as soon as something is pending, or after this long (default 0 = answer immediately).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dsh_approvals_resolve",
    title: "Answer a sandbox escalation",
    description:
      'Answer one pending request. "allow-once" widens that session\'s permission preset and lets the held call run; "reject" refuses it and the ' +
      "agent is told the call was not executed. Prefer reject unless the command in argv is exactly what you asked for — an approval is a decision " +
      "about that command, not a general grant, and a session may win at most a few before the bridge stops asking.",
    inputSchema: {
      type: "object",
      properties: {
        approval_id: { type: "string", description: "The approvalId from dsh_approvals_pending." },
        decision: { type: "string", enum: ["allow-once", "reject"], description: "What to answer." },
        note: { type: "string", description: "Optional note shown to the agent alongside the decision." },
      },
      required: ["approval_id", "decision"],
      additionalProperties: false,
    },
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
    name: "dsh_history",
    title: "Read Harness session history",
    description:
      "Read the recent event window of a session: tool calls, tool results, turn ends, approvals and sandbox changes. " +
      "Read-only — it never activates the session's agent. Use it when dsh_wait's answer is not enough to see what the " +
      "Harness actually did. `limit` (default 40, max 500) is the window hint passed to the session store — it is " +
      "not a hard cap, and the header always reports the window size that actually arrived. since/kinds filter " +
      "inside that window, so a delta larger than the window is silently incomplete; raise `limit` when needed. " +
      "`turn` and `running` describe the whole window, not the filtered subset; `max_chars: 0` is unlimited and a positive cap keeps the newest records that fit with `truncated: true`.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id, as printed by dsh_ask/dsh_wait ('session <id>')." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Window hint: how many of the newest events to ask the session store for (default 40). Not a hard cap — read the header for the size that arrived." },
        kinds: { type: "array", items: { type: "string" }, description: 'Event types to keep (default ["tool/call","tool/result","turn/end"]); pass ["*"] for every type.' },
        since: { type: "integer", minimum: 0, description: "Only events with seq > since (the cursor printed by dsh_ask/dsh_wait)." },
        max_chars: { type: "integer", minimum: 0, maximum: 200000, description: "Cap the serialized records (0 = unlimited)." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_wait",
    title: "Wait for a Harness turn",
    description:
      "Block until the turn currently running on a session finishes, then return its text. This is the supported way to collect work after " +
      "a timeout or after dsh_ask with wait:false — do not resend the prompt. Pass the `since` cursor from the previous answer to get only " +
      "what happened afterwards. Use dsh_history to inspect the recent event window when the answer is not enough.",
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
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 3600000,
          description:
            "How long to wait for the turn to finish (milliseconds). Defaults to the bridge's configured value (600000)." +
            " An outer client cap (Codex tool_timeout_sec) applies before the bridge budget; keep slices short and poll again with since.",
        },
        trace: {
          type: "string",
          enum: ["none", "errors", "summary", "full"],
          description:
            "How much tool-call trace to render alongside the answer. Defaults to the bridge's traceDefault (errors). 'none' restores the pre-0.8.1 output.",
        },
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
    description:
      "Report the bridge version, mounted endpoint, token source and any active runs. " +
      "Use dsh_sessions and dsh_history to inspect sessions and their recent events.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "dsh_capabilities",
    title: "Inspect Harness capabilities",
    description:
      "Read-only snapshot of what this Harness can do right now across eight sections " +
      "(identity, runtime, permissions, tools, mcp, sessions, workspace, plugins). " +
      "`unavailable` means this host does not expose that fact here — not that it does not exist. " +
      "Does not create, resume, or touch any session.",
    inputSchema: {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: { type: "string" },
          description:
            'Section ids to include (default ["*"] for all eight: identity, runtime, permissions, tools, mcp, sessions, workspace, plugins).',
        },
        max_chars: {
          type: "integer",
          minimum: 0,
          maximum: 40000,
          description: "Cap the rendered text length (default 8000; 0 = uncapped, hard ceiling 40000).",
        },
        session_id: {
          type: "string",
          description: "Optional session id to include caller session facts in `permissions` and `sessions`.",
        },
      },
      additionalProperties: false,
    },
  },
];

const TASK_TOOLS = [
  {
    name: "dsh_task_submit",
    title: "Submit a task to the DSH task center",
    description:
      "Idempotently submit a task to the DSH task ledger. Pass preview_id (recommended) or workspace_id + agent_id + capability_revision_id.",
    inputSchema: {
      type: "object",
      properties: {
        idempotency_key: { type: "string", description: "Caller-chosen idempotency key (auto-generated if omitted)." },
        preview_id: { type: "string", description: "One-shot preview id from dsh.tasks.preview." },
        principal_id: { type: "string", description: "Caller principal id (defaults to local-operator)." },
        workspace_id: { type: "string", description: "Workspace id (required when preview_id is omitted)." },
        agent_id: { type: "string", description: "Target agent id (required when preview_id is omitted)." },
        capability_revision_id: { type: "string", description: "Capability revision id (required when preview_id is omitted)." },
        prompt: { type: "string", description: "Task prompt text (packaged into input if input is omitted)." },
        input: { type: "object", description: "Structured task input payload." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dsh_task_list",
    title: "List DSH tasks",
    description: "List tasks in the DSH task center with optional status, workspace, or cursor filters.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by task state." },
        workspace_id: { type: "string", description: "Filter by workspace id." },
        principal_id: { type: "string", description: "Filter by principal id." },
        cursor: { type: "string", description: "Pagination cursor from previous response." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max items to return (default 50)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dsh_task_get",
    title: "Get DSH task detail",
    description: "Inspect a task's authoritative state, derived phase, active attempt, pending items, and artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id to inspect." },
        principal_id: { type: "string", description: "Optional principal scope." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_task_cancel",
    title: "Request cancellation of a DSH task",
    description:
      "Durably register a cancellation request on a task (transitions to cancel_requested, or needs_reconcile if executor lacks cancel support).",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id to cancel." },
        expected_state_version: { type: "integer", minimum: 1, description: "Current stateVersion for optimistic locking." },
        idempotency_key: { type: "string", description: "Idempotency key (auto-generated if omitted)." },
        reason: { type: "string", description: "Optional human-readable cancellation reason." },
        principal_id: { type: "string", description: "Optional principal scope." },
      },
      required: ["task_id", "expected_state_version"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_agents_list",
    title: "List registered task-center agents",
    description: "List agent capability cards registered in the DSH task center with probe status.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Filter by adapter kind." },
        enabled: { type: "boolean", description: "Filter by enabled flag." },
        verified_only: { type: "boolean", description: "Only return fully verified agents." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dsh_agents_probe",
    title: "Probe an agent's read-only controls",
    description: "Run read-only control probes on a registered agent and update verified vs unknown controls.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Registered agent id." },
        controls: { type: "array", items: { type: "string" }, description: "Subset of controls to probe." },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_task_preview",
    title: "Preview a task before submitting it",
    description:
      "Resolve which agent would take a task, what capabilities it would use, and why others were excluded. Previews are one-shot and expire.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Workspace id the task would run in." },
        agent_id: { type: "string", description: "Explicit agent id (skips selection)." },
        capability_revision_id: { type: "string", description: "Capability revision id (required when agent_id is given)." },
        principal_id: { type: "string", description: "Caller principal id (required)." },
        input: { type: "object", description: "Structured task input payload." },
        prompt: { type: "string", description: "Task prompt text (packaged into input if input is omitted)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dsh_task_events",
    title: "Read a DSH task's event log",
    description: "Read a task's own timeline after a cursor. Task id plus seq is the dedupe key.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id." },
        after_seq: { type: "integer", minimum: 0, description: "Return events with seq greater than this (default 0)." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Max events (default 100)." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_task_read_artifact",
    title: "Read an artifact of a DSH task",
    description: "Read a recorded artifact by id, with an optional byte window. Text is returned as utf8, anything else as base64.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id." },
        artifact_id: { type: "string", description: "Artifact id from the task detail." },
        offset: { type: "integer", minimum: 0, description: "Byte offset (default 0)." },
        length: { type: "integer", minimum: 1, maximum: 1000000, description: "Bytes to return (default 20000)." },
      },
      required: ["task_id", "artifact_id"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_task_input",
    title: "Answer a waiting DSH task",
    description:
      "Record a human answer for a task that is waiting for input. Delivery is asynchronous; poll dsh_task_get to see the task working again.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id." },
        text: { type: "string", description: "Answer text delivered to the runtime." },
        idempotency_key: { type: "string", description: "Idempotency key (auto-generated if omitted)." },
        attempt_id: { type: "string", description: "Active attempt id (optional guard)." },
        question_id: { type: "string", description: "Open question id this answers (optional guard)." },
        principal_id: { type: "string", description: "Caller principal id." },
      },
      required: ["task_id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_agents_get",
    title: "Read one registered agent",
    description: "Read a registered agent's card, published capability revisions and probe status.",
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string", description: "Registered agent id." } },
      required: ["agent_id"],
      additionalProperties: false,
    },
  },
];

const TOOLS = [...BASE_TOOLS, ...TASK_TOOLS];
const TASK_TOOL_NAMES = new Set(TASK_TOOLS.map((t) => t.name));

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

const IS_MAIN =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
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
}

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

      case "tools/list": {
        const tools = await listTools();
        reply(id, { tools });
        return;
      }

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
const DEFAULT_MAX_RESULT_CHARS = 20000;
const MAX_ADVISED_SESSIONS = 200;

// One-shot timeout advice per session id, bounded so long-lived MCP processes
// do not grow without limit.
const advisedTimeoutSessions = new Set();

function maybeTimeoutAdvice(result, requestedMs, enabled) {
  const sessionId = typeof result?.sessionId === "string" && result.sessionId.length > 0 ? result.sessionId : null;
  const alreadyShown = sessionId !== null && advisedTimeoutSessions.has(sessionId);
  if (
    !shouldAdviseTimeout({
      status: result?.status,
      timedOut: result?.timedOut,
      requestedMs,
      enabled,
      alreadyShown,
    })
  ) {
    return null;
  }
  if (sessionId !== null) {
    if (advisedTimeoutSessions.size >= MAX_ADVISED_SESSIONS) {
      const oldest = advisedTimeoutSessions.values().next().value;
      if (oldest !== undefined) advisedTimeoutSessions.delete(oldest);
    }
    advisedTimeoutSessions.add(sessionId);
  }
  return TIMEOUT_ADVICE;
}

/** Out-wait the server's turn budget so the bridge never aborts a live turn. */
function turnBudget(timeoutMs) {
  return (Number.isInteger(timeoutMs) ? timeoutMs : DEFAULT_TURN_TIMEOUT_MS) + 30_000;
}

// The bridge may configure other budgets than these literals. Ask it once, then
// quote its answer in hints and use it as the default turn budget — a hint that
// names 600000 against a 10-minute deployment is exactly the drift the audit
// flagged.
let bridgeDefaults = null;
let bridgeMethods = null;

function resetBridgeDefaults() {
  bridgeDefaults = null;
  bridgeMethods = null;
}

async function bridgeSettings() {
  if (bridgeDefaults !== null) return bridgeDefaults;
  try {
    const info = await rpcCall("dsh.discover", {}, { timeoutMs: 5_000 });
    bridgeDefaults = { ...(info?.config ?? {}) };
    bridgeMethods = Array.isArray(info?.methods) ? info.methods.map((m) => m.name) : null;
  } catch {
    // A bridge that cannot answer now will fail the real call with a better
    // message; the literal default keeps the hint usable meanwhile.
    bridgeDefaults = {};
    bridgeMethods = null;
  }
  return bridgeDefaults;
}

// Three outcomes matter, not two (t4 finding D1): "disabled" means the 0.9.0
// plugin is loaded with the switch off — a config change fixes it; "unsupported"
// means the plugin predates the task centre, where telling the caller to set
// `tasksEnabled` is advice that cannot work.
const TASK_CENTRE_ENABLED = "enabled";
const TASK_CENTRE_DISABLED = "disabled";
const TASK_CENTRE_UNSUPPORTED = "unsupported";

async function taskCentreState(callFn = (method, params, options) => rpcCall(method, params, options)) {
  const defaults = await bridgeSettings();
  if (defaults.tasksEnabled === false) return TASK_CENTRE_DISABLED;
  if (defaults.tasksEnabled === true) {
    if (Array.isArray(bridgeMethods)) {
      return bridgeMethods.includes("dsh.tasks.list") ? TASK_CENTRE_ENABLED : TASK_CENTRE_UNSUPPORTED;
    }
    return TASK_CENTRE_ENABLED;
  }
  // 0.8.x plugins publish no `config.tasksEnabled`; a successful probe is the only proof.
  try {
    await callFn("dsh.tasks.list", { limit: 1 }, { timeoutMs: 3_000 });
    return TASK_CENTRE_ENABLED;
  } catch {
    return Array.isArray(bridgeMethods) && !bridgeMethods.includes("dsh.tasks.list")
      ? TASK_CENTRE_UNSUPPORTED
      : TASK_CENTRE_DISABLED;
  }
}

async function isTasksEnabled(callFn = (method, params, options) => rpcCall(method, params, options)) {
  return (await taskCentreState(callFn)) === TASK_CENTRE_ENABLED;
}

async function listTools() {
  const enabled = await isTasksEnabled();
  return enabled ? [...BASE_TOOLS, ...TASK_TOOLS] : [...BASE_TOOLS];
}

function formatTaskSummary(task, maxResultChars = DEFAULT_MAX_RESULT_CHARS) {
  const header = `task ${task.taskId ?? "?"} · ${task.status ?? "unknown"} · ${task.phase ?? "unknown"}`;
  const bodyLines = [];
  if (task.agentId) bodyLines.push(`agent: ${task.agentId}`);
  if (task.workspaceId) bodyLines.push(`workspace: ${task.workspaceId}`);
  if (task.notice) bodyLines.push(`notice: ${task.notice}`);
  if (task.result !== undefined && task.result !== null) {
    bodyLines.push(`result: ${JSON.stringify(task.result)}`);
  }
  if (task.error) bodyLines.push(`error: ${JSON.stringify(task.error)}`);
  const meta = [
    `v${task.stateVersion ?? "?"}`,
    task.deduplicated ? "deduplicated" : null,
    task.requestAccepted ? "requestAccepted" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const content = capText(
    [
      { type: "text", text: header },
      { type: "text", text: bodyLines.length > 0 ? bodyLines.join("\n") : "(no details)" },
      { type: "text", text: `— ${meta}` },
    ],
    maxResultChars,
  );
  return {
    content,
    isError: false,
    structuredContent: task,
  };
}

// Keys that would reach Object.prototype if any later code copies arguments
// with Object.assign or [[Set]]. JSON.parse stores them as own properties, so
// the danger is downstream, not here — refuse them at the door.
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_SCHEMA_DEPTH = 8;

function validateValue(schema, value, path, depth = 0) {
  if (!schema || typeof schema !== "object") return null;
  if (depth > MAX_SCHEMA_DEPTH) {
    return `invalid arguments: ${path} — nesting deeper than ${MAX_SCHEMA_DEPTH} levels`;
  }

  if (schema.type === "string" && typeof value !== "string") {
    return `invalid arguments: ${path} — expected string`;
  }
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    return `invalid arguments: ${path} — expected number`;
  }
  if (schema.type === "integer" && !Number.isInteger(value)) {
    return `invalid arguments: ${path} — expected integer`;
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    return `invalid arguments: ${path} — expected boolean`;
  }
  if (schema.type === "array" && !Array.isArray(value)) {
    return `invalid arguments: ${path} — expected array`;
  }
  if (schema.type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) {
    return `invalid arguments: ${path} — expected object`;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `invalid arguments: ${path} — \`${path}\` must be one of ${schema.enum.join(", ")}`;
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `invalid arguments: ${path} — must be >= ${schema.minimum}`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `invalid arguments: ${path} — must be <= ${schema.maximum}`;
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      const err = validateValue(schema.items, value[i], `${path}[${i}]`, depth + 1);
      if (err) return err;
    }
  }

  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!Object.hasOwn(value, reqKey) || value[reqKey] === undefined) {
          const reqPath = path === "arguments" ? reqKey : `${path}.${reqKey}`;
          return `invalid arguments: ${reqPath} — \`${reqKey}\` is required`;
        }
      }
    }
    const props = schema.properties && typeof schema.properties === "object" ? schema.properties : null;
    if (schema.additionalProperties === false && props) {
      for (const key of Object.keys(value)) {
        // `key in props` is true for "__proto__" on every plain object, so a
        // prototype key slipped past additionalProperties:false. hasOwn is the
        // check that actually means "the schema lists this property".
        if (PROTO_KEYS.has(key) || !Object.hasOwn(props, key)) {
          const propPath = path === "arguments" ? key : `${path}.${key}`;
          return `invalid arguments: ${propPath} — unknown property "${key}"`;
        }
      }
    }
    if (props) {
      for (const [key, val] of Object.entries(value)) {
        if (PROTO_KEYS.has(key) || val === undefined || !Object.hasOwn(props, key)) continue;
        const propPath = path === "arguments" ? key : `${path}.${key}`;
        const err = validateValue(props[key], val, propPath, depth + 1);
        if (err) return err;
      }
    }
  }

  return null;
}

function validateToolArgs(schema, args) {
  const normalized = args === undefined ? {} : args;
  return validateValue(schema, normalized, "arguments", 0);
}

async function callTool(name, args, signal = undefined) {
  // Cancellation from the client has to reach the request that is still in flight;
  // these two wrappers are the only places that talk to the bridge from here.
  const call = (method, params, options = {}) => rpcCall(method, params, signal ? { ...options, signal } : options);
  const waitTurn = (sessionId, options = {}) => waitForTurn(sessionId, signal ? { ...options, signal } : options);
  try {
    const defaults = await bridgeSettings();
    const turnDefault = Number.isInteger(defaults.defaultTimeoutMs) ? defaults.defaultTimeoutMs : DEFAULT_TURN_TIMEOUT_MS;
    const traceDefault = normalizeTraceLevel(defaults.traceDefault, "errors");
    const maxResultChars =
      Number.isInteger(defaults.maxResultChars) && defaults.maxResultChars >= 0
        ? defaults.maxResultChars
        : DEFAULT_MAX_RESULT_CHARS;
    const adviceEnabled = typeof defaults.timeoutAdvice === "boolean" ? defaults.timeoutAdvice : true;
    const hintOptions = { defaultTimeoutMs: turnDefault, maxResultChars, adviceEnabled };

    if (TASK_TOOL_NAMES.has(name)) {
      const centre = await taskCentreState(call);
      if (centre !== TASK_CENTRE_ENABLED) {
        const unsupported = centre === TASK_CENTRE_UNSUPPORTED;
        return formatToolError(
          unsupported
            ? "this Harness plugin does not implement the task centre (0.9.0)"
            : "task centre is disabled: set config.tasksEnabled=true",
          { tool: name },
          unsupported
            ? "upgrade the plugin inside the DSH profile to 0.9.0 — the MCP bridge and the plugin ship together"
            : "enable config.tasksEnabled on the bridge before calling task tools",
        );
      }
    }

    const toolDef = TOOLS.find((t) => t.name === name);
    if (toolDef?.inputSchema) {
      const schemaErr = validateToolArgs(toolDef.inputSchema, args);
      if (schemaErr) {
        return formatToolError(schemaErr, undefined, -32602);
      }
    }

    switch (name) {
      case "dsh_ask": {
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        if (prompt.trim().length === 0) {
          return formatToolError("`prompt` is required", undefined, "pass the task as a self-contained prompt string");
        }
        const params = { text: prompt };
        if (args.session_id !== undefined) {
          if (typeof args.session_id !== "string" || !args.session_id.trim()) {
            return formatToolError("`session_id` must be a non-empty string", undefined, -32602);
          }
          params.sessionId = args.session_id.trim();
        }
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
        const askFormatOptions = {
          ...hintOptions,
          trace: normalizeTraceLevel(args.trace, traceDefault),
          since: null,
        };

        if (params.wait === false) {
          const result = await call("dsh.sessions.ask", params, { timeoutMs: turnBudget(args.timeout_ms ?? turnDefault) });
          return formatToolResult(result, askFormatOptions);
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
            const merged = {
              ...first,
              ...waited,
              text: waited.text || first.text,
              tools: waited.tools?.length > 0 ? waited.tools : first.tools,
              durationMs: (first.durationMs ?? 0) + (waited.waitedMs ?? 0),
            };
            return formatToolResult(merged, {
              ...askFormatOptions,
              advice: maybeTimeoutAdvice(merged, timeoutMs, adviceEnabled),
            });
          }
        }
        return formatToolResult(first, {
          ...askFormatOptions,
          advice: maybeTimeoutAdvice(first, timeoutMs, adviceEnabled),
        });
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

      case "dsh_approvals_pending": {
        const params = {};
        if (args.session_id !== undefined) {
          if (typeof args.session_id !== "string" || !args.session_id.trim()) {
            return formatToolError("`session_id` must be a non-empty string", undefined, -32602);
          }
          params.sessionId = args.session_id.trim();
        }
        if (Number.isInteger(args.wait_ms)) params.waitMs = args.wait_ms;
        const result = await call("dsh.approvals.pending", params);
        const pending = Array.isArray(result.pending) ? result.pending : [];
        if (pending.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  result.mode === "delegate"
                    ? `(no escalation is waiting${result.timedOut ? " yet" : ""})`
                    : `(this bridge does not hold escalations: approvals.mode=${result.mode}; nothing can be pending)`,
              },
            ],
          };
        }
        const lines = pending.map((item) => {
          // The whole call, not one field of it: a `write_file` keeps its payload in
          // `content`, so showing only `command`/`path` would let the interesting
          // half of a call stay invisible to the caller deciding on it.
          const shown = typeof item.args === "string" && item.args.length > 0 ? item.args : item.argv || "(unknown)";
          return [
            `${item.approvalId}  ${item.sessionId}  ${item.toolName} → ${item.escalation}`,
            `  call: ${shown}`,
            item.argsTruncated ? "  (truncated for display; the packet keeps the front of the call)" : null,
            item.cwd ? `  cwd: ${item.cwd}` : null,
            item.preset ? `  current preset: ${item.preset}` : null,
            item.reason ? `  reason (the agent's own words, untrusted): ${item.reason}` : null,
            `  expires: ${new Date(item.expiresAt).toISOString()}`,
            `  answer with dsh_approvals_resolve({ approval_id: "${item.approvalId}", decision: "allow-once" | "reject" })`,
          ]
            .filter(Boolean)
            .join("\n");
        });
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      }
      case "dsh_approvals_resolve": {
        const approvalId = typeof args.approval_id === "string" ? args.approval_id.trim() : "";
        if (!approvalId) return formatToolError("`approval_id` is required", undefined, -32602);
        if (args.decision !== "allow-once" && args.decision !== "reject") {
          return formatToolError('`decision` must be "allow-once" or "reject"', undefined, -32602);
        }
        const resolved = await call("dsh.approvals.resolve", {
          approvalId,
          decision: args.decision,
          ...(typeof args.note === "string" ? { note: args.note } : {}),
        });
        return {
          content: [
            {
              type: "text",
              text:
                `${resolved.decision}: ${resolved.toolName} in ${resolved.sessionId} ` +
                `(approval ${resolved.approvalId})` +
                (resolved.decision === "allow-once"
                  ? "\nnext: the held call runs now under the widened preset; the preset goes back as soon as that call finishes (five minutes at the latest)."
                  : "\nnext: the agent was told the call was not executed; do not resend the same escalation."),
            },
          ],
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

      case "dsh_history": {
        const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
        if (!sessionId) {
          return formatToolError("`session_id` is required", undefined, "call dsh_sessions() to find the session id");
        }
        const params = { sessionId };
        if (args.limit !== undefined) params.limit = args.limit;
        if (args.since !== undefined) params.since = args.since;
        if (args.max_chars !== undefined) params.maxChars = args.max_chars;

        let kinds;
        if (args.kinds === undefined) {
          kinds = DEFAULT_HISTORY_KINDS;
        } else if (Array.isArray(args.kinds) && args.kinds.length === 1 && args.kinds[0] === "*") {
          kinds = "*";
        } else {
          kinds = args.kinds;
        }
        params.kinds = kinds;

        const payload = await call("dsh.sessions.history", params);
        const since = Number.isInteger(args.since) ? args.since : null;
        const formatted = formatHistory(payload, { since, kinds, requestedMaxChars: args.max_chars });
        const parts = [formatted.header];
        // A note means the plugin answered without honouring since/kinds: say so
        // instead of printing a delta the caller would trust and be wrong about.
        if (formatted.note) parts.push(`note: ${formatted.note}`);
        if (formatted.empty) {
          parts.push("records: 0 events in this window — the session may be new, or the filters dropped everything.");
        } else {
          parts.push(...formatted.lines);
        }
        return {
          content: [{ type: "text", text: parts.join("\n") }],
          isError: false,
          structuredContent: formatted.structured,
        };
      }

      case "dsh_wait": {
        const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
        if (!sessionId) return formatToolError("`session_id` is required", undefined, "call dsh_sessions() to find the session id");
        const since = Number.isInteger(args.since) ? args.since : null;
        const requestedMs = Number.isInteger(args.timeout_ms) ? args.timeout_ms : turnDefault;
        // Sliced on purpose: see waitTurn(). One long request cannot survive
        // the transport's 300 s ceiling, and the answer would be lost with it.
        const result = await waitTurn(sessionId, {
          timeoutMs: requestedMs,
          since: since ?? undefined,
        });
        return formatToolResult(result, {
          ...hintOptions,
          trace: normalizeTraceLevel(args.trace, traceDefault),
          since,
          advice: maybeTimeoutAdvice(result, requestedMs, adviceEnabled),
        });
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

      case "dsh_capabilities": {
        const params = {};
        if (args.sections !== undefined) params.sections = args.sections;
        if (args.max_chars !== undefined) params.max_chars = args.max_chars;
        if (args.session_id !== undefined) {
          if (typeof args.session_id !== "string" || !args.session_id.trim()) {
            return formatToolError("`session_id` must be a non-empty string", undefined, -32602);
          }
          params.session_id = args.session_id.trim();
        }
        // A newer CLI/MCP bridge can be paired with an older plugin inside the
        // profile: the tool exists here but the RPC method does not exist there.
        // Say which half is stale instead of forwarding "unknown method" verbatim.
        let payload;
        try {
          payload = await call("dsh.capabilities", params);
        } catch (error) {
          const message = String(error?.message ?? error);
          if (!/unknown method/i.test(message)) throw error;
          return formatToolError(
            "this Harness plugin does not implement dsh.capabilities",
            undefined,
            "upgrade the plugin inside the DSH profile to 0.8.1 — the MCP bridge and the plugin ship together",
          );
        }
        const sections = Array.isArray(payload?.sections) ? payload.sections : [];
        const missing = Array.isArray(payload?.missing) ? payload.missing : [];
        const truncated = Boolean(payload?.truncated);
        const text =
          typeof payload?.text === "string" && payload.text.length > 0
            ? payload.text
            : formatCapabilities(sections, {
                maxChars: args.max_chars,
                missing,
              }).text;
        return {
          content: [{ type: "text", text }],
          isError: false,
          structuredContent: {
            sections,
            truncated,
            missing,
          },
        };
      }

      case "dsh_task_preview": {
        const params = {};
        if (typeof args.workspace_id === "string" && args.workspace_id.trim()) params.workspaceId = args.workspace_id.trim();
        if (typeof args.agent_id === "string" && args.agent_id.trim()) params.agentId = args.agent_id.trim();
        if (typeof args.capability_revision_id === "string" && args.capability_revision_id.trim()) {
          params.capabilityRevisionId = args.capability_revision_id.trim();
        }
        if (typeof args.principal_id === "string" && args.principal_id.trim()) params.principalId = args.principal_id.trim();
        if (args.input !== undefined) {
          if (args.input === null || typeof args.input !== "object" || Array.isArray(args.input)) {
            return formatToolError("`input` must be a plain JSON object", undefined, -32602);
          }
          params.input = args.input;
        } else if (typeof args.prompt === "string" && args.prompt.trim()) {
          params.input = { prompt: args.prompt.trim() };
        }
        const result = await call("dsh.tasks.preview", params);
        return formatTaskSummary(result, maxResultChars);
      }

      case "dsh_task_events": {
        const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
        if (!taskId) return formatToolError("`task_id` is required", undefined, -32602);
        const params = { taskId };
        if (args.after_seq !== undefined) {
          if (!Number.isInteger(args.after_seq) || args.after_seq < 0) {
            return formatToolError("`after_seq` must be a non-negative integer", undefined, -32602);
          }
          params.afterSeq = args.after_seq;
        }
        if (args.limit !== undefined) {
          if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 500) {
            return formatToolError("`limit` must be an integer between 1 and 500", undefined, -32602);
          }
          params.limit = args.limit;
        }
        const result = await call("dsh.tasks.events", params);
        const events = Array.isArray(result?.events) ? result.events : [];
        const lines = events.map((e) => `#${e.seq} ${e.type}${e.attemptId ? " · " + e.attemptId : ""}`);
        const content = capText(
          [
            { type: "text", text: `events (${events.length})` },
            { type: "text", text: lines.length > 0 ? lines.join("\n") : "(no events)" },
            { type: "text", text: `— hasMore=${Boolean(result?.hasMore)} nextAfterSeq=${result?.nextAfterSeq ?? 0}` },
          ],
          maxResultChars,
        );
        return { content, isError: false, structuredContent: result };
      }

      case "dsh_task_read_artifact": {
        const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
        const artifactId = typeof args.artifact_id === "string" ? args.artifact_id.trim() : "";
        if (!taskId) return formatToolError("`task_id` is required", undefined, -32602);
        if (!artifactId) return formatToolError("`artifact_id` is required", undefined, -32602);
        const params = { taskId, artifactId };
        if (args.offset !== undefined) {
          if (!Number.isInteger(args.offset) || args.offset < 0) {
            return formatToolError("`offset` must be a non-negative integer", undefined, -32602);
          }
          params.offset = args.offset;
        }
        if (args.length !== undefined) {
          if (!Number.isInteger(args.length) || args.length < 1 || args.length > 1_000_000) {
            return formatToolError("`length` must be an integer between 1 and 1000000", undefined, -32602);
          }
          params.length = args.length;
        }
        const result = await call("dsh.tasks.readArtifact", params);
        const body = result?.encoding === "base64" ? `(base64, ${result?.bytesRead ?? 0} bytes)` : String(result?.content ?? "");
        const content = capText(
          [
            { type: "text", text: `artifact ${result?.artifactId} · ${result?.kind} · ${result?.sizeBytes} bytes` },
            { type: "text", text: body },
            {
              type: "text",
              text: `— offset=${result?.offset ?? 0} bytesRead=${result?.bytesRead ?? 0} truncated=${Boolean(result?.truncated)}`,
            },
          ],
          maxResultChars,
        );
        return { content, isError: false, structuredContent: result };
      }

      case "dsh_task_input": {
        const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!taskId) return formatToolError("`task_id` is required", undefined, -32602);
        if (!text) return formatToolError("`text` is required", undefined, -32602);
        const params = {
          taskId,
          text,
          idempotencyKey:
            typeof args.idempotency_key === "string" && args.idempotency_key.trim()
              ? args.idempotency_key.trim()
              : `mcp_input_${randomUUID()}`,
        };
        if (typeof args.attempt_id === "string" && args.attempt_id.trim()) params.attemptId = args.attempt_id.trim();
        if (typeof args.question_id === "string" && args.question_id.trim()) params.questionId = args.question_id.trim();
        if (typeof args.principal_id === "string" && args.principal_id.trim()) params.principalId = args.principal_id.trim();
        const result = await call("dsh.tasks.input", params);
        return formatTaskSummary(
          { taskId: result?.taskId, status: "input queued", phase: "person/delivery", ...result },
          maxResultChars,
        );
      }

      case "dsh_agents_get": {
        const agentId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
        if (!agentId) return formatToolError("`agent_id` is required", undefined, -32602);
        const result = await call("dsh.agents.get", { agentId });
        const caps = Array.isArray(result?.capabilityRevisions) ? result.capabilityRevisions.length : 0;
        const content = capText(
          [
            { type: "text", text: `agent ${result?.agentId} · ${result?.adapterKind} · probeStatus=${result?.probeStatus ?? "unknown"}` },
            { type: "text", text: `— capability revisions: ${caps}` },
          ],
          maxResultChars,
        );
        return { content, isError: false, structuredContent: result };
      }

      case "dsh_task_submit": {
        if (args.input !== undefined) {
          if (args.input === null || typeof args.input !== "object" || Array.isArray(args.input)) {
            return formatToolError("`input` must be a plain JSON object", undefined, -32602);
          }
        }
        if (args.preview_id !== undefined && (typeof args.preview_id !== "string" || !args.preview_id.trim())) {
          return formatToolError("`preview_id` must be a non-empty string", undefined, -32602);
        }
        const params = {
          idempotencyKey:
            typeof args.idempotency_key === "string" && args.idempotency_key.trim()
              ? args.idempotency_key.trim()
              : `mcp_${randomUUID()}`,
        };
        if (typeof args.preview_id === "string" && args.preview_id.trim()) params.previewId = args.preview_id.trim();
        if (typeof args.principal_id === "string" && args.principal_id.trim()) params.principalId = args.principal_id.trim();
        if (typeof args.workspace_id === "string" && args.workspace_id.trim()) params.workspaceId = args.workspace_id.trim();
        if (typeof args.agent_id === "string" && args.agent_id.trim()) params.agentId = args.agent_id.trim();
        if (typeof args.capability_revision_id === "string" && args.capability_revision_id.trim()) {
          params.capabilityRevisionId = args.capability_revision_id.trim();
        }
        if (args.input !== undefined) params.input = args.input;
        else if (typeof args.prompt === "string" && args.prompt.trim()) params.input = { prompt: args.prompt.trim() };
        const result = await call("dsh.tasks.submit", params);
        return formatTaskSummary(result, maxResultChars);
      }

      case "dsh_task_list": {
        const params = {};
        if (typeof args.status === "string" && args.status.trim()) params.status = args.status.trim();
        if (typeof args.workspace_id === "string" && args.workspace_id.trim()) params.workspaceId = args.workspace_id.trim();
        if (typeof args.principal_id === "string" && args.principal_id.trim()) params.principalId = args.principal_id.trim();
        if (typeof args.cursor === "string" && args.cursor.trim()) params.cursor = args.cursor.trim();
        if (args.limit !== undefined) {
          if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200) {
            return formatToolError("`limit` must be an integer between 1 and 200", undefined, -32602);
          }
          params.limit = args.limit;
        }
        const result = await call("dsh.tasks.list", params);
        const items = Array.isArray(result?.items) ? result.items : [];
        const lines = items.map(
          (item) => `task ${item.taskId ?? "?"} · ${item.status ?? "unknown"} · ${item.phase ?? "unknown"}`,
        );
        const content = capText(
          [
            { type: "text", text: `tasks (${items.length})` },
            { type: "text", text: lines.length > 0 ? lines.join("\n") : "(no tasks)" },
            { type: "text", text: `— hasMore=${Boolean(result?.hasMore)}` },
          ],
          maxResultChars,
        );
        return {
          content,
          isError: false,
          structuredContent: result,
        };
      }

      case "dsh_task_get": {
        const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
        if (!taskId) return formatToolError("`task_id` is required", undefined, -32602);
        const params = { taskId };
        if (typeof args.principal_id === "string" && args.principal_id.trim()) params.principalId = args.principal_id.trim();
        const result = await call("dsh.tasks.get", params);
        return formatTaskSummary(result, maxResultChars);
      }

      case "dsh_task_cancel": {
        const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
        if (!taskId) return formatToolError("`task_id` is required", undefined, -32602);
        if (!Number.isInteger(args.expected_state_version) || args.expected_state_version < 1) {
          return formatToolError("`expected_state_version` must be a positive integer", undefined, -32602);
        }
        const params = {
          taskId,
          expectedStateVersion: args.expected_state_version,
          idempotencyKey:
            typeof args.idempotency_key === "string" && args.idempotency_key.trim()
              ? args.idempotency_key.trim()
              : `mcp_cancel_${randomUUID()}`,
        };
        if (typeof args.reason === "string" && args.reason.trim()) params.reason = args.reason.trim();
        if (typeof args.principal_id === "string" && args.principal_id.trim()) params.principalId = args.principal_id.trim();
        const result = await call("dsh.tasks.cancel", params);
        return formatTaskSummary({ phase: result.status === "needs_reconcile" ? "person/reconcile" : "machine/working", ...result }, maxResultChars);
      }

      case "dsh_agents_list": {
        const params = {};
        if (typeof args.kind === "string" && args.kind.trim()) params.kind = args.kind.trim();
        if (typeof args.enabled === "boolean") params.enabled = args.enabled;
        if (typeof args.verified_only === "boolean") params.verifiedOnly = args.verified_only;
        const result = await call("dsh.agents.list", params);
        const items = Array.isArray(result?.items) ? result.items : [];
        const lines = items.map(
          (a) => `agent ${a.agentId} · ${a.kind} · ${a.probeStatus ?? "unknown"}`,
        );
        const content = capText(
          [
            { type: "text", text: `agents (${items.length})` },
            { type: "text", text: lines.length > 0 ? lines.join("\n") : "(no agents registered)" },
            { type: "text", text: `— total=${result?.total ?? items.length}` },
          ],
          maxResultChars,
        );
        return {
          content,
          isError: false,
          structuredContent: result,
        };
      }

      case "dsh_agents_probe": {
        const agentId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
        if (!agentId) return formatToolError("`agent_id` is required", undefined, -32602);
        const params = { agentId };
        if (args.controls !== undefined) {
          if (!Array.isArray(args.controls) || args.controls.some((c) => typeof c !== "string" || !c.trim())) {
            return formatToolError("`controls` must be an array of non-empty strings", undefined, -32602);
          }
          params.controls = args.controls.map((c) => c.trim());
        }
        const result = await call("dsh.agents.probe", params);
        const header = `agent ${result.agentId} · ${result.probeStatus ?? "unknown"}`;
        const body = `verified: ${(result.verifiedControls ?? Object.keys(result.verified ?? {})).join(", ") || "(none)"}\nunknown: ${(result.unknown ?? []).map((u) => `${u.control}(${u.reason})`).join(", ") || "(none)"}`;
        const content = capText(
          [
            { type: "text", text: header },
            { type: "text", text: body },
            { type: "text", text: `— elapsedMs=${result.elapsedMs ?? 0}` },
          ],
          maxResultChars,
        );
        return {
          content,
          isError: false,
          structuredContent: result,
        };
      }

      default:
        return formatToolError(`unknown tool: ${name}`, undefined, "call tools/list for the supported names");
    }
  } catch (error) {
    // `code` is the JSON-RPC code the bridge answered with; toolError turns it
    // into the concrete next step instead of leaving the caller to guess.
    // Never surface raw adapter/transport/internal exception text to MCP callers.
    const isAdapterOrInternal =
      error?.data?.kind === "ADAPTER_UNAVAILABLE" ||
      error?.taskCode === "ADAPTER_UNAVAILABLE" ||
      !Number.isInteger(error?.code) ||
      error.code === -32000 ||
      error.code === -32603;
    if (TASK_TOOL_NAMES.has(name) && isAdapterOrInternal) {
      const safe = sanitizeAdapterFailure(error);
      return formatToolError(
        safe.message,
        safe.code || safe.kind || safe.httpStatus
          ? { code: safe.code, kind: safe.kind, httpStatus: safe.httpStatus }
          : undefined,
        error?.code,
      );
    }
    return formatToolError(error instanceof Error ? error.message : String(error), error?.data, error?.code);
  }
}

if (IS_MAIN) {
  log(`ready (${SERVER_INFO.name} ${SERVER_INFO.version})`);
}

export { BASE_TOOLS, TASK_TOOLS, TOOLS, callTool, handleLine, isTasksEnabled, listTools, resetBridgeDefaults, validateToolArgs };
