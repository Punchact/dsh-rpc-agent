#!/usr/bin/env node
// Command-line client for @punchact/dsh-rpc-agent.
//
//   node bin/dsh-rpc.mjs ask "explain this repository" --cwd . --json
//   node bin/dsh-rpc.mjs ping
//   node bin/dsh-rpc.mjs call dsh.sessions.list '{"limit":5}'
//
// The endpoint and token resolve from (in order) --url/--token, DSH_RPC_URL /
// DSH_RPC_TOKEN, then the files the plugin publishes under $DSH_HOME/dsh-rpc/.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rpcCall, rpcStream, waitForTurn, WAIT_SLICE_MS } from "../lib/client.mjs";
import { ADAPTER_FAILURE_MESSAGES, sanitizeAdapterFailure } from "../lib/adapters/base.mjs";
import { endpointPath, readEndpoint, stateDir, tokenPath } from "../lib/auth.mjs";
import { describeTrace, isTraceLevel, normalizeTraceLevel } from "../lib/trace-format.mjs";

const HELP = `dsh-rpc ${new Date().getUTCFullYear()} — drive a DeepSeek Harness session from the command line

USAGE
  dsh-rpc <command> [options] [args]

COMMANDS
  ping                      show bridge status, config and active runs
  discover                  list every RPC method with its params and result shape
  capabilities              report what this Harness can do across eight sections
  models                    list routable providers and models
  workspaces                list the workspaces the Host shows in its sidebar
  permissions               list the permission presets this deployment offers
  health [--wait MS]        unauthenticated liveness probe (with --wait, poll until ready)
  sessions [--limit N]      list Harness sessions
  create [--cwd DIR]        create a blank session
  ask <prompt...>           create/reuse a session, prompt it, wait for the turn
  prompt --session ID <p>   submit a prompt and return immediately
  wait --session ID         wait for the turn already running on a session
  cancel --session ID       cancel the in-flight turn
  history --session ID      show the recent event window
  tasks <subcommand>        manage task-center tasks (preview|submit|list|get|cancel|dispatch|pump|reconcile|approve|resolve)
  agents <subcommand>       manage agent capability cards (register|list|probe)
  call <method> [json]      raw JSON-RPC call (json params optional)
  env                       print the endpoint and token as shell exports

OPTIONS
  --cwd DIR                 working directory for a new session
  --workspace ID            put a new session in this workspace (exclusive with --cwd)
  --session ID              reuse an existing session
  --preset NAME             agent preset for a new session
  --model NAME              model for the next turn ("provider/model" or a bare id)
  --effort NAME             reasoning effort (needs --model in the same call)
  --permission NAME         permission preset for the next turn
  --mode queue|steer        prompt delivery mode (default queue)
  --queue                   wait for the session when another run is prompting it
  --timeout MS              wait budget for ask/wait (default 600000)
  --limit N                 list/history size
  --sections IDS            capabilities: comma-separated section ids (default *)
  --max-chars N             capabilities: cap output characters (0 = uncapped, max 40000)
  --wait MS                 health: keep polling the published endpoint until it answers
  --trace LEVEL             tool-call trace: none|errors|summary|full (default: bridge traceDefault)
  --stream                  stream progress frames while waiting (ask)
  --json                    print the raw JSON result
  --url URL                 override the endpoint
  --token TOKEN             override the bearer token
  -h, --help                this text

EXIT CODES
  0 done   1 failed or turn not completed   2 usage error   3 connection error

Endpoint discovery (auto): $DSH_HOME/dsh-rpc/endpoint.json and .../token
  state dir : ${stateDir()}
  token file: ${tokenPath()}
  endpoint  : ${endpointPath()}
`;

const BOOLEAN_FLAGS = new Set(["json", "stream", "help", "verbose", "queue", "verified-only", "enabled"]);
const VALUE_FLAGS = new Set([
  "cwd",
  "workspace",
  "session",
  "preset",
  "model",
  "effort",
  "permission",
  "mode",
  "timeout",
  "since",
  "limit",
  "sections",
  "max-chars",
  "wait",
  "trace",
  "url",
  "token",
  "task",
  "agent",
  "capability",
  "principal",
  "preview",
  "idempotency-key",
  "expected-version",
  "reason",
  "status",
  "cursor",
  "max-steps",
  "observed",
  "note",
  "result",
  "digest",
  "ttl",
  "input",
  "file",
  "kind",
  "controls",
  "project",
  "title",
  "attempt",
  "approval",
  "decision",
  "after-seq",
]);

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      if (equals >= 0) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      if (VALUE_FLAGS.has(body)) {
        const value = argv[index + 1];
        if (value === undefined) throw new UsageError(`--${body} needs a value`);
        flags[body] = value;
        index += 1;
        continue;
      }
      throw new UsageError(`unknown option: --${body}`);
    }
    if (token === "-h") {
      flags.help = true;
      continue;
    }
    positional.push(token);
  }
  return { flags, positional };
}

class UsageError extends Error {}

function connectionOptions(flags) {
  return { url: flags.url, token: flags.token };
}

function numberOf(flags, key, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (flags[key] === undefined) return undefined;
  const raw = typeof flags[key] === "string" ? flags[key].trim() : "";
  if (!/^-?\d+$/.test(raw)) {
    throw new UsageError(`--${key} must be a safe integer between ${min} and ${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new UsageError(`--${key} must be a safe integer between ${min} and ${max}`);
  }
  return value;
}

function cursorOf(flags, key) {
  return numberOf(flags, key, { min: 0, max: Number.MAX_SAFE_INTEGER });
}

function shellDoubleQuote(value) {
  return `"${String(value).replace(/[\\"$`]/g, "\\$&")}"`;
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function readPrompt(positional) {
  if (positional.length === 0) throw new UsageError("missing prompt text");
  if (positional.length === 1 && positional[0] === "-") {
    return readFileSync(0, "utf8");
  }
  return positional.join(" ");
}

function print(text) {
  if (text === undefined || text === null || text === "") return;
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function note(text) {
  process.stderr.write(`${text}\n`);
}

/** Human footer describing how the turn ended; kept off stdout. */
function footer(result) {
  const bits = [`session ${result.sessionId ?? "?"}`];
  if (result.turn !== undefined && result.turn !== null) bits.push(`turn ${result.turn}`);
  bits.push(result.status ?? "unknown");
  if (typeof result.durationMs === "number") bits.push(`${(result.durationMs / 1000).toFixed(1)}s`);
  if (Array.isArray(result.tools) && result.tools.length > 0) bits.push(`${result.tools.length} tool calls`);
  if (result.timedOut) bits.push("(timed out; the turn may still be running)");
  return bits.join(" · ");
}

async function resolveCliTraceLevel(flags) {
  if (flags.trace !== undefined) {
    if (!isTraceLevel(flags.trace)) {
      throw new UsageError("--trace must be one of: none, errors, summary, full");
    }
    return normalizeTraceLevel(flags.trace);
  }
  if (flags.json) return "none";
  try {
    const info = await rpcCall("dsh.discover", {}, { ...connectionOptions(flags), timeoutMs: 5_000 });
    return normalizeTraceLevel(info?.config?.traceDefault, "errors");
  } catch {
    return "errors";
  }
}

function emitResult(result, flags, traceLevel = "none", since = null) {
  if (flags.json) {
    print(JSON.stringify(result, null, 2));
  } else {
    if (result.text) print(result.text);
    else if (result.status !== "completed") note("(no assistant text)");
    if (flags.verbose && result.reason) note(`reason: ${JSON.stringify(result.reason)}`);
    if (traceLevel !== "none") {
      const trace = describeTrace(result?.tools ?? [], {
        level: traceLevel,
        status: result?.status,
        since: Number.isInteger(since) ? since : null,
      });
      if (trace.lines.length > 0) {
        print(`\ntrace:\n${trace.lines.join("\n")}`);
      }
    }
  }
  note(footer(result));
}

const DEFAULT_TURN_TIMEOUT_MS = 600000;

/** The client must out-wait the server's turn budget, or it aborts a live turn. */
function turnBudget(timeoutMs) {
  return (timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS) + 30_000;
}

async function runAsk(flags, positional) {
  const traceLevel = await resolveCliTraceLevel(flags);
  const text = await readPrompt(positional);
  const params = { text };
  // Location and preset are creation-time decisions, and the bridge is the only
  // place that knows it. Forwarding them unconditionally means a caller that asks
  // for both a session and a location gets the bridge's refusal, rather than having
  // the flag silently dropped here.
  if (flags.session) params.sessionId = flags.session;
  if (flags.cwd) params.cwd = flags.cwd;
  if (flags.workspace) params.workspaceId = flags.workspace;
  if (flags.preset) params.agentPreset = flags.preset;
  if (flags.model) params.model = flags.model;
  if (flags.effort) params.reasoningEffort = flags.effort;
  if (flags.permission) params.permissionPreset = flags.permission;
  if (flags.mode) params.mode = flags.mode;
  if (flags.queue) params.queue = true;
  const timeout = numberOf(flags, "timeout");
  if (timeout) params.timeoutMs = timeout;
  const budget = { ...connectionOptions(flags), timeoutMs: turnBudget(timeout) };

  if (flags.stream) {
    let final = null;
    for await (const frame of rpcStream(params, budget)) {
      if (frame.type === "session") note(`session ${frame.sessionId}`);
      else if (frame.type === "progress") renderProgress(frame.frame, flags);
      else if (frame.type === "result") final = frame;
      else if (frame.type === "error") throw new Error(frame.error?.message ?? "stream error");
    }
    if (!final) throw new Error("stream ended without a result");
    const { type, ...result } = final;
    emitResult(result, flags, traceLevel, null);
    return exitCodeFor(result);
  }

  // One request cannot stay quiet past the transport's 300 s ceiling, so a
  // blocking ask is a short ask plus a sliced wait. Anything the ask already
  // collected is kept if the wait comes back empty.
  const budgetMs = timeout ?? DEFAULT_TURN_TIMEOUT_MS;
  const slice = Math.min(budgetMs, WAIT_SLICE_MS);
  const first = await rpcCall(
    "dsh.sessions.ask",
    { ...params, timeoutMs: slice },
    { ...connectionOptions(flags), timeoutMs: slice + 30_000 },
  );
  let result = first;
  if (first?.status === "timeout" && typeof first.sessionId === "string") {
    const left = budgetMs - (first.durationMs ?? slice);
    if (left > 1_000) {
      const waited = await waitForTurn(first.sessionId, { timeoutMs: left, ...connectionOptions(flags) });
      result = {
        ...first,
        ...waited,
        text: waited.text || first.text,
        tools: waited.tools?.length > 0 ? waited.tools : first.tools,
        durationMs: (first.durationMs ?? 0) + (waited.waitedMs ?? 0),
      };
    }
  }
  emitResult(result, flags, traceLevel, null);
  return exitCodeFor(result);
}

function renderProgress(frame, flags) {
  if (!flags.verbose || !frame) return;
  if (frame.type === "snapshot") {
    note(`snapshot: turn ${frame.turn}${frame.running ? " (running)" : ""}`);
    return;
  }
  if (frame.type !== "event") return;
  const event = frame.event;
  if (!event) return;
  if (event.type === "tool/call") note(`→ ${event.data?.name ?? "tool"}`);
  else if (event.type === "turn/start") note(`turn ${event.data?.turn} started`);
}

function exitCodeFor(result) {
  return result?.status === "completed" || result?.status === "idle" ? 0 : 1;
}

/**
 * `process.exit()` truncates stdout when it is a pipe, which silently eats the
 * tail of a long answer. Wait for both streams to drain, then exit.
 */
function flushStdio() {
  const drain = (stream) =>
    new Promise((resolve) => {
      if (!stream || stream.destroyed || stream.writableEnded) {
        resolve();
        return;
      }
      stream.write("", () => resolve());
    });
  return Promise.all([drain(process.stdout), drain(process.stderr)]);
}

const CONNECTION_FAILURES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT"]);

function failureExitCode(error) {
  const code = error?.code ?? error?.cause?.code;
  if (CONNECTION_FAILURES.has(code)) return 3;
  if (error?.name === "TimeoutError") return 3;
  return 1;
}

const HEALTH_POLL_MS = 250;
// A single liveness probe nobody answers must not wait for undici's own 300s
// header deadline; a probe is only useful if it is short.
const HEALTH_PROBE_TIMEOUT_MS = 5000;

/**
 * Probe `/health`, optionally polling until a deadline.
 *
 * `--wait` exists because the interesting moment for a health probe is right
 * after a restart: the Web server may not be listening yet, and a single shot
 * then reports a connection error that says nothing about whether the bridge is
 * coming up. Each poll re-reads the published endpoint, because a restart also
 * moves the port. Every attempt is capped by what is left of the budget, so
 * `--wait 5000` cannot take minutes when the address accepts but never answers.
 */
async function probeHealth(explicitUrl, budgetMs) {
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  let failure = { kind: "transport", message: "the plugin has not published an endpoint yet" };

  for (;;) {
    const target = explicitUrl ?? readEndpoint()?.url;
    if (target) {
      const limit = budgetMs > 0 ? Math.max(50, deadline - Date.now()) : HEALTH_PROBE_TIMEOUT_MS;
      try {
        const response = await fetch(`${target.replace(/\/+$/, "")}/health`, {
          signal: AbortSignal.timeout(limit),
        });
        const body = await response.text();
        if (response.ok) {
          print(body);
          if (budgetMs > 0) note(`ready after ${Date.now() - startedAt}ms`);
          return 0;
        }
        failure = { kind: "http", message: `HTTP ${response.status}` };
      } catch (error) {
        failure = { kind: "transport", message: error.message };
      }
    }
    if (Date.now() >= deadline) break;
    const pause = Math.max(10, Math.min(HEALTH_POLL_MS, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, pause));
  }

  note(`health check failed after ${Date.now() - startedAt}ms: ${failure.message}`);
  return failure.kind === "http" ? 1 : 3;
}

/**
 * Mixed-version hint (acceptance A18): a 0.9.0 bridge talking to a pre-0.9.0 plugin
 * must say what to do next instead of leaking the raw RPC error, and may never
 * half-succeed. Returns the hint line, or null when the error is unrelated.
 */
function mixedVersionHint(message) {
  if (!/unknown method: dsh\.(tasks|agents)\./.test(typeof message === "string" ? message : "")) {
    return null;
  }
  return "  next: this Harness plugin predates the task centre (0.9.0). Upgrade the plugin inside the DSH profile — the bridge and the plugin ship together.";
}

async function main(argv) {
  const { flags, positional } = parseArgv(argv);
  if (flags.help || positional.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  const [command, ...rest] = positional;
  const options = connectionOptions(flags);

  switch (command) {
    case "ping": {
      const result = await rpcCall("dsh.ping", {}, options);
      print(flags.json ? JSON.stringify(result, null, 2) : [
        `plugin     : ${result.plugin} ${result.version} (protocol ${result.protocol})`,
        `origin     : ${result.origin ?? "unknown"}`,
        `endpoint   : ${result.config?.path ?? "/dsh-rpc"}`,
        `loopback   : ${result.config?.allowRemote ? "off (allowRemote)" : "on"}`,
        `token src  : ${result.state?.tokenSource} → ${result.state?.tokenPath ?? ""}`,
        `active runs: ${result.activeRuns?.length ?? 0}`,
      ].join("\n"));
      return 0;
    }
    case "discover": {
      const result = await rpcCall("dsh.discover", {}, options);
      if (flags.json) {
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      for (const method of result.methods ?? []) {
        print(`${method.name}`);
        print(`  ${method.summary}`);
        const params = Object.keys(method.params ?? {});
        if (params.length > 0) {
          for (const key of params) print(`    ${key}: ${method.params[key]}`);
        } else {
          print("    (no params)");
        }
        print(`  → ${method.returns}`);
      }
      return 0;
    }
    case "models": {
      const result = await rpcCall("dsh.models", {}, options);
      print(JSON.stringify(result, null, 2));
      return 0;
    }
    case "workspaces": {
      const result = await rpcCall("dsh.workspaces.list", {}, options);
      if (flags.json) {
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      if ((result.items ?? []).length === 0) {
        note("no workspaces are registered yet");
        return 0;
      }
      for (const item of result.items) {
        print(`${item.id}  ${item.title}  [${item.status}, ${item.sessions} sessions]`);
        print(`  ${item.path}`);
      }
      return 0;
    }
    case "permissions": {
      const result = await rpcCall("dsh.permissions.catalog", {}, options);
      if (flags.json) {
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      for (const option of result.options ?? []) {
        const mark = option.value === result.defaultPreset ? "*" : " ";
        print(`${mark} ${option.value}  ${option.name}`);
        if (option.description) print(`    ${option.description}`);
      }
      if (result.defaultPreset) note(`* = default preset (${result.defaultPreset})`);
      return 0;
    }
    case "health": {
      // Unauthenticated, so it needs no token — but it still needs an address,
      // and the plugin publishes one; requiring --url here was pure friction.
      const budget = numberOf(flags, "wait") ?? 0;
      const target = flags.url ?? (budget > 0 ? null : readEndpoint()?.url);
      if (!target && budget === 0) {
        note("health needs --url (the plugin has not published an endpoint yet)");
        return 2;
      }
      return await probeHealth(target, budget);
    }
    case "sessions": {
      const params = {};
      const limit = numberOf(flags, "limit");
      if (limit) params.limit = limit;
      const result = await rpcCall("dsh.sessions.list", params, options);
      if (flags.json) {
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      for (const item of result.items ?? []) {
        const marks = [item.running ? "running" : "idle", item.blank ? "blank" : null]
          .filter(Boolean)
          .join(",");
        print(`${item.sessionId}  ${marks}  ${item.cwd ?? ""}`);
      }
      note(`${result.total} session(s)`);
      return 0;
    }
    case "create": {
      const params = {};
      if (flags.cwd) params.cwd = flags.cwd;
      if (flags.workspace) params.workspaceId = flags.workspace;
      if (flags.preset) params.agentPreset = flags.preset;
      if (flags.model) params.model = flags.model;
      if (flags.effort) params.reasoningEffort = flags.effort;
      if (flags.permission) params.permissionPreset = flags.permission;
      const result = await rpcCall("dsh.sessions.create", params, options);
      print(flags.json ? JSON.stringify(result, null, 2) : result.sessionId);
      return 0;
    }
    case "ask":
      return runAsk(flags, rest);
    case "prompt": {
      if (!flags.session) throw new UsageError("prompt needs --session <id>");
      const text = await readPrompt(rest);
      const params = { sessionId: flags.session, text };
      if (flags.model) params.model = flags.model;
      if (flags.effort) params.reasoningEffort = flags.effort;
      if (flags.permission) params.permissionPreset = flags.permission;
      if (flags.mode) params.mode = flags.mode;
      const result = await rpcCall("dsh.sessions.prompt", params, options);
      print(flags.json ? JSON.stringify(result, null, 2) : result.requestId);
      return 0;
    }
    case "wait": {
      if (!flags.session) throw new UsageError("wait needs --session <id>");
      const timeout = numberOf(flags, "timeout");
      const since = cursorOf(flags, "since");
      const traceLevel = await resolveCliTraceLevel(flags);
      const result = await waitForTurn(flags.session, {
        timeoutMs: timeout ?? DEFAULT_TURN_TIMEOUT_MS,
        since,
        ...options,
      });
      emitResult(result, flags, traceLevel, since ?? null);
      return exitCodeFor(result);
    }
    case "cancel": {
      if (!flags.session) throw new UsageError("cancel needs --session <id>");
      const result = await rpcCall("dsh.sessions.cancel", { sessionId: flags.session }, options);
      print(flags.json ? JSON.stringify(result, null, 2) : `cancelled ${result.sessionId}`);
      return 0;
    }
    case "history": {
      if (!flags.session) throw new UsageError("history needs --session <id>");
      const params = { sessionId: flags.session };
      const limit = numberOf(flags, "limit");
      if (limit) params.limit = limit;
      const result = await rpcCall("dsh.sessions.history", params, options);
      if (flags.json) {
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      print(
        `${result.records?.length ?? 0} event(s), turn ${result.turn}, ${result.running ? "running" : "idle"}`,
      );
      for (const record of result.records ?? []) {
        print(`  ${String(record.seq).padStart(5)} ${record.type}`);
      }
      return 0;
    }
    case "capabilities": {
      const params = {};
      if (flags.sections !== undefined) {
        const parts = String(flags.sections)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        if (parts.length === 0) throw new UsageError("--sections needs at least one section id");
        params.sections = parts;
      }
      if (flags["max-chars"] !== undefined) {
        const raw = Number(flags["max-chars"]);
        if (!Number.isInteger(raw) || raw < 0 || raw > 40000) {
          throw new UsageError("--max-chars must be an integer between 0 and 40000");
        }
        params.max_chars = raw;
      }
      if (flags.session) params.session_id = flags.session;
      const result = await rpcCall("dsh.capabilities", params, options);
      if (flags.json) {
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      print(result.text ?? "");
      if (Array.isArray(result.missing) && result.missing.length > 0) {
        note(`ignored unknown sections: ${result.missing.join(", ")}`);
      }
      return 0;
    }
    case "call": {
      const [method, rawParams] = rest;
      if (!method) throw new UsageError("call needs a method name");
      let params = {};
      if (rawParams !== undefined) {
        try {
          params = JSON.parse(rawParams);
        } catch {
          throw new UsageError("call params must be valid JSON");
        }
      }
      // `--timeout` used to apply to ask/wait only, so `call dsh.sessions.wait`
      // silently ran on the 120 s control budget. Now it means the same thing
      // here, and a wait goes through the sliced loop like every other wait.
      const timeout = numberOf(flags, "timeout");
      if (method === "dsh.sessions.wait" && typeof params?.sessionId === "string") {
        const jsonTimeout = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : undefined;
        const result = await waitForTurn(params.sessionId, {
          timeoutMs: timeout ?? jsonTimeout ?? DEFAULT_TURN_TIMEOUT_MS,
          since: Number.isInteger(params.since) ? params.since : undefined,
          ...connectionOptions(flags),
        });
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      const result = await rpcCall(method, params, timeout ? { ...connectionOptions(flags), timeoutMs: timeout } : options);
      print(JSON.stringify(result, null, 2));
      return 0;
    }
    case "env": {
      const endpoint = readEndpoint();
      const url = flags.url ?? process.env.DSH_RPC_URL ?? endpoint?.url;
      if (url && !process.env.DSH_RPC_URL) print(`export DSH_RPC_URL=${shellDoubleQuote(url)}`);
      else if (!url) print("# no endpoint published yet — start the Harness once with the plugin enabled");
      if (!process.env.DSH_RPC_TOKEN && !flags.token) {
        print(`export DSH_RPC_TOKEN="$(cat ${shellSingleQuote(tokenPath().replace(/\\/g, "/"))})"`);
      }
      return 0;
    }
    case "tasks":
      return await runTasksCommand(flags, rest, options);
    case "agents":
      return await runAgentsCommand(flags, rest, options);
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

function parseJsonFlag(raw, name) {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`--${name} must be valid JSON`);
  }
}

async function runTasksCommand(flags, rest, options) {
  const [sub, ...args] = rest;
  if (!sub) throw new UsageError("tasks needs a subcommand: preview|submit|list|get|cancel|dispatch|pump|reconcile|approve|resolve");
  const firstId = flags.task ?? args[0];
  if (flags["after-seq"] !== undefined) {
    cursorOf(flags, "after-seq");
  }

  switch (sub) {
    case "preview": {
      const params = {
        principalId: flags.principal ?? "local-operator",
        capabilityRevisionId: flags.capability,
        workspaceId: flags.workspace ?? "local",
        agentId: flags.agent,
      };
      if (!params.capabilityRevisionId) throw new UsageError("tasks preview needs --capability <revisionId>");
      if (!params.agentId) throw new UsageError("tasks preview needs --agent <agentId>");
      if (flags.digest) params.requestDigest = flags.digest;
      if (flags.ttl !== undefined) params.ttlMs = numberOf(flags, "ttl", { min: 1000, max: 3_600_000 });
      if (flags.input !== undefined) params.input = parseJsonFlag(flags.input, "input");
      const result = await rpcCall("dsh.tasks.preview", params, options);
      print(
        flags.json
          ? JSON.stringify(result, null, 2)
          : `preview ${result.previewId}  agent=${result.agentId}  expires=${result.expiresAt}`,
      );
      return 0;
    }
    case "submit": {
      const params = {
        idempotencyKey: flags["idempotency-key"] ?? `cli_${randomUUID()}`,
      };
      if (flags.preview) params.previewId = flags.preview;
      if (flags.principal) params.principalId = flags.principal;
      if (flags.workspace) params.workspaceId = flags.workspace;
      if (flags.agent) params.agentId = flags.agent;
      if (flags.capability) params.capabilityRevisionId = flags.capability;
      if (flags.input !== undefined) params.input = parseJsonFlag(flags.input, "input");
      else if (args.length > 0) params.input = { prompt: args.join(" ") };
      const result = await rpcCall("dsh.tasks.submit", params, options);
      print(
        flags.json
          ? JSON.stringify(result, null, 2)
          : `task ${result.taskId} · ${result.status} · ${result.phase ?? "?"}${result.deduplicated ? " (deduplicated)" : ""}`,
      );
      return 0;
    }
    case "list": {
      const params = {};
      if (flags.status) params.status = flags.status;
      if (flags.workspace) params.workspaceId = flags.workspace;
      if (flags.principal) params.principalId = flags.principal;
      if (flags.cursor) params.cursor = flags.cursor;
      const limit = numberOf(flags, "limit", { min: 1, max: 200 });
      if (limit) params.limit = limit;
      const result = await rpcCall("dsh.tasks.list", params, options);
      if (flags.json) {
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      for (const item of result.items ?? []) {
        print(`task ${item.taskId} · ${item.status} · ${item.phase ?? "?"}  v${item.stateVersion}`);
      }
      note(`${(result.items ?? []).length} task(s)${result.hasMore ? ` (next cursor: ${result.nextCursor})` : ""}`);
      return 0;
    }
    case "events": {
      if (!firstId) throw new UsageError("tasks events needs <taskId> or --task <id>");
      const params = { taskId: firstId };
      if (flags.after) params.afterSeq = numberOf(flags, "after", { min: 0, max: Number.MAX_SAFE_INTEGER });
      const limit = numberOf(flags, "limit", { min: 1, max: 500 });
      if (limit) params.limit = limit;
      const result = await rpcCall("dsh.tasks.events", params, options);
      if (flags.json) {
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      for (const event of result.events ?? []) {
        const attempt = event.attemptId ? ` · ${event.attemptId}` : "";
        print(`#${event.seq} ${event.type}${attempt} · ${event.at}`);
      }
      note(
        `${(result.events ?? []).length} event(s)${result.hasMore ? ` (next afterSeq: ${result.nextAfterSeq})` : ""}`,
      );
      return 0;
    }
    case "input": {
      if (!firstId) throw new UsageError("tasks input needs <taskId> or --task <id>");
      const text = flags.text !== undefined ? String(flags.text) : args.slice(1).join(" ");
      if (!text.trim()) throw new UsageError("tasks input needs --text <answer> (or the answer as trailing text)");
      const params = {
        taskId: firstId,
        text: text.trim(),
        idempotencyKey: flags["idempotency-key"] ?? `cli_input_${randomUUID()}`,
      };
      if (flags.attempt) params.attemptId = String(flags.attempt);
      if (flags.question) params.questionId = String(flags.question);
      if (flags.principal) params.principalId = flags.principal;
      const result = await rpcCall("dsh.tasks.input", params);
      print(
        flags.json
          ? JSON.stringify(result, null, 2)
          : `task ${result.taskId} · input ${result.inputId} · ${result.deliveryStatus}${result.deduplicated ? " (deduplicated)" : ""}`,
      );
      return 0;
    }
    case "artifact": {
      if (!firstId) throw new UsageError("tasks artifact needs <taskId> <artifactId>");
      const artifactId = args[1];
      if (!artifactId) throw new UsageError("tasks artifact needs <taskId> <artifactId>");
      const params = { taskId: firstId, artifactId };
      const offset = numberOf(flags, "offset", { min: 0, max: Number.MAX_SAFE_INTEGER });
      if (offset) params.offset = offset;
      const length = numberOf(flags, "length", { min: 1, max: 1000000 });
      if (length) params.length = length;
      const result = await rpcCall("dsh.tasks.readArtifact", params);
      if (flags.json) {
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      print(
        `artifact ${result.artifactId} · ${result.kind} · ${result.sizeBytes} bytes · ${result.encoding}`,
      );
      print(result.content ?? "");
      note(
        `offset=${result.offset} bytesRead=${result.bytesRead}${result.truncated ? " (truncated; raise --length or use --offset)" : ""}`,
      );
      return 0;
    }
    case "get": {
      if (!firstId) throw new UsageError("tasks get needs <taskId> or --task <id>");
      const params = { taskId: firstId };
      if (flags.principal) params.principalId = flags.principal;
      const result = await rpcCall("dsh.tasks.get", params, options);
      if (flags.json) {
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      print(`task ${result.taskId} · ${result.status} · ${result.phase ?? "?"} · v${result.stateVersion}`);
      if (result.notice) print(`notice: ${result.notice}`);
      return 0;
    }
    case "cancel": {
      if (!firstId) throw new UsageError("tasks cancel needs <taskId> or --task <id>");
      const expectedStateVersion = numberOf(flags, "expected-version");
      if (!expectedStateVersion) throw new UsageError("tasks cancel needs --expected-version <N>");
      const params = {
        taskId: firstId,
        expectedStateVersion,
        idempotencyKey: flags["idempotency-key"] ?? `cli_cancel_${randomUUID()}`,
      };
      if (flags.reason) params.reason = flags.reason;
      if (flags.principal) params.principalId = flags.principal;
      const result = await rpcCall("dsh.tasks.cancel", params, options);
      print(
        flags.json
          ? JSON.stringify(result, null, 2)
          : `task ${result.taskId} · ${result.status} · v${result.stateVersion}${result.notice ? ` (${result.notice})` : ""}`,
      );
      return 0;
    }
    case "dispatch": {
      if (!firstId) throw new UsageError("tasks dispatch needs <taskId> or --task <id>");
      const params = { taskId: firstId };
      const promptArgs = flags.task ? args : args.slice(1);
      if (promptArgs.length > 0) params.prompt = promptArgs.join(" ");
      if (flags.model) params.model = flags.model;
      if (flags.project) params.projectId = flags.project;
      if (flags.title) params.title = flags.title;
      const result = await rpcCall("dsh.tasks.dispatch", params, options);
      const knownSafeMessages = new Set(Object.values(ADAPTER_FAILURE_MESSAGES));
      const safeError =
        result.dispatchFailed && result.error
          ? knownSafeMessages.has(result.error)
            ? result.error
            : sanitizeAdapterFailure({ message: result.error }).message
          : result.error;
      const safeResult = result.dispatchFailed ? { ...result, error: safeError } : result;
      print(
        flags.json
          ? JSON.stringify(safeResult, null, 2)
          : `task ${safeResult.taskId} · ${safeResult.status} · v${safeResult.stateVersion}${safeResult.dispatchFailed ? ` (failed: ${safeResult.error})` : ""}`,
      );
      return safeResult.dispatchFailed ? 1 : 0;
    }
    case "pump": {
      if (!firstId) throw new UsageError("tasks pump needs <taskId> or --task <id>");
      const params = { taskId: firstId };
      const maxSteps = numberOf(flags, "max-steps", { min: 1, max: 1000 });
      if (maxSteps) params.maxSteps = maxSteps;
      const timeout = numberOf(flags, "timeout", { min: 1, max: 3_600_000 });
      if (timeout) params.deadlineMs = timeout;
      if (flags.cursor !== undefined) {
        const rawCur = String(flags.cursor).trim();
        if (!rawCur) throw new UsageError("--cursor must be non-empty");
        if (/^-?[\d.eE+-]+$/.test(rawCur)) {
          params.cursor = cursorOf(flags, "cursor");
        } else {
          params.cursor = rawCur;
        }
      }
      const result = await rpcCall("dsh.tasks.pump", params, options);
      print(
        flags.json
          ? JSON.stringify(result, null, 2)
          : `task ${result.taskId} · ${result.status} · steps=${result.stepsProcessed}`,
      );
      return 0;
    }
    case "reconcile": {
      if (!firstId) throw new UsageError("tasks reconcile needs <taskId> or --task <id>");
      if (!flags.observed) throw new UsageError("tasks reconcile needs --observed succeeded|failed|cancelled");
      const evidence = { observedState: flags.observed };
      if (flags.note) evidence.note = flags.note;
      if (flags.result !== undefined) evidence.result = parseJsonFlag(flags.result, "result");
      const result = await rpcCall("dsh.tasks.reconcile", { taskId: firstId, evidence }, options);
      print(
        flags.json
          ? JSON.stringify(result, null, 2)
          : `task ${result.taskId} · ${result.from} -> ${result.status} · closed=${result.attemptsClosed}`,
      );
      return 0;
    }
    case "resolve": {
      if (!firstId) throw new UsageError("tasks resolve needs <taskId> or --task <id>");
      const expected = numberOf(flags, "expected-version", { min: 1 });
      if (!expected) throw new UsageError("tasks resolve needs --expected-version <stateVersion>");
      const disposition = flags.decision;
      if (!["accept", "reject", "cancel", "requeue"].includes(disposition)) {
        throw new UsageError("tasks resolve needs --decision accept|reject|cancel|requeue");
      }
      const params = {
        taskId: firstId,
        expectedStateVersion: expected,
        disposition,
        idempotencyKey: flags["idempotency-key"] ?? `cli_resolve_${randomUUID()}`,
      };
      if (flags.note) params.note = flags.note;
      if (flags.evidence !== undefined) params.evidenceRef = parseJsonFlag(flags.evidence, "evidence");
      if (flags.principal) params.resolvedBy = flags.principal;
      const result = await rpcCall("dsh.tasks.resolve", params, options);
      print(
        flags.json
          ? JSON.stringify(result, null, 2)
          : `task ${result.taskId} · ${result.status} · ${result.disposition} · v${result.stateVersion}`,
      );
      return 0;
    }
    case "approve": {
      if (!firstId) throw new UsageError("tasks approve needs <taskId> or --task <id>");
      const attemptId = flags.attempt;
      if (!attemptId) throw new UsageError("tasks approve needs --attempt <attemptId>");
      const approvalId = flags.approval;
      if (!approvalId) throw new UsageError("tasks approve needs --approval <approvalId>");
      const decision = flags.decision;
      if (decision !== "allow" && decision !== "deny") {
        throw new UsageError("tasks approve needs --decision allow|deny");
      }
      const params = { taskId: firstId, attemptId, approvalId, decision };
      if (flags.reason) params.reason = flags.reason;
      if (flags["idempotency-key"]) params.idempotencyKey = flags["idempotency-key"];
      const result = await rpcCall("dsh.tasks.decideApproval", params, options);
      print(
        flags.json
          ? JSON.stringify(result, null, 2)
          : `task ${result.taskId} · approval ${result.approvalId} -> ${result.decision} · ${result.status} · v${result.stateVersion}`,
      );
      return 0;
    }
    default:
      throw new UsageError(`unknown tasks subcommand: ${sub}`);
  }
}

async function runAgentsCommand(flags, rest, options) {
  const [sub, ...args] = rest;
  if (!sub) throw new UsageError("agents needs a subcommand: register|list|probe");

  switch (sub) {
    case "register": {
      let payload;
      if (flags.file) {
        try {
          payload = JSON.parse(readFileSync(flags.file, "utf8"));
        } catch (err) {
          throw new UsageError(`cannot read --file ${flags.file}: ${err?.message ?? err}`);
        }
      } else if (args[0]) {
        payload = parseJsonFlag(args[0], "card");
      } else {
        throw new UsageError("agents register needs --file <card.json> or inline JSON");
      }
      const params = payload?.card ? payload : { card: payload };
      if (flags.enabled !== undefined) params.enabled = Boolean(flags.enabled);
      const result = await rpcCall("dsh.agents.register", params, options);
      print(
        flags.json
          ? JSON.stringify(result, null, 2)
          : `agent ${result.agentId} · probeStatus=${result.probeStatus}`,
      );
      return 0;
    }
    case "list": {
      const params = {};
      if (flags.kind) params.kind = flags.kind;
      if (flags["verified-only"]) params.verifiedOnly = true;
      const result = await rpcCall("dsh.agents.list", params, options);
      if (flags.json) {
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      for (const item of result.items ?? []) {
        print(`agent ${item.agentId} · ${item.kind} · ${item.probeStatus}`);
      }
      note(`${result.total ?? (result.items ?? []).length} agent(s)`);
      return 0;
    }
    case "get": {
      const agentId = flags.agent ?? args[0];
      if (!agentId) throw new UsageError("agents get needs <agentId> or --agent <id>");
      const result = await rpcCall("dsh.agents.get", { agentId }, options);
      if (flags.json) {
        print(JSON.stringify(result, null, 2));
        return 0;
      }
      print(
        `agent ${result.agentId} · ${result.adapterKind} · probeStatus=${result.probeStatus ?? "unknown"} · revisions=${(result.capabilityRevisions ?? []).length}`,
      );
      for (const rev of result.capabilityRevisions ?? []) {
        print(`  ${rev.capability}@${rev.version} · ${rev.revisionId} · cancel=${rev.cancelPolicy}`);
      }
      return 0;
    }
    case "probe": {
      const agentId = flags.agent ?? args[0];
      if (!agentId) throw new UsageError("agents probe needs <agentId> or --agent <id>");
      const params = { agentId };
      if (flags.controls) {
        params.controls = String(flags.controls)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      const result = await rpcCall("dsh.agents.probe", params, options);
      print(
        flags.json
          ? JSON.stringify(result, null, 2)
          : `agent ${result.agentId} · ${result.probeStatus} · unknown=${(result.unknown ?? []).length}`,
      );
      return 0;
    }
    default:
      throw new UsageError(`unknown agents subcommand: ${sub}`);
  }
}

const IS_MAIN =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  main(process.argv.slice(2))
    .then(async (code) => {
      await flushStdio();
      process.exit(code);
    })
    .catch(async (error) => {
      if (error instanceof UsageError) {
        note(`dsh-rpc: ${error.message}`);
        note("run `dsh-rpc --help` for usage");
        await flushStdio();
        process.exit(2);
      }
      const code = failureExitCode(error);
      note(
        code === 3
          ? `dsh-rpc: cannot reach the Harness (is it running?) — ${error?.message ?? error}`
          : `dsh-rpc: ${error?.message ?? error}`,
      );
      if (error?.data) note(`  ${JSON.stringify(error.data)}`);
      const hint = mixedVersionHint(error?.message);
      if (hint) note(hint);
      await flushStdio();
      process.exit(code);
    });
}

export { UsageError, main, mixedVersionHint, parseArgv, runAgentsCommand, runTasksCommand };
