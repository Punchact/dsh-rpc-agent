#!/usr/bin/env node
// Command-line client for @punchact/dsh-rpc.
//
//   node bin/dsh-rpc.mjs ask "explain this repository" --cwd . --json
//   node bin/dsh-rpc.mjs ping
//   node bin/dsh-rpc.mjs call dsh.sessions.list '{"limit":5}'
//
// The endpoint and token resolve from (in order) --url/--token, DSH_RPC_URL /
// DSH_RPC_TOKEN, then the files the plugin publishes under $DSH_HOME/dsh-rpc/.

import { readFileSync } from "node:fs";

import { rpcCall, rpcStream } from "../lib/client.mjs";
import { endpointPath, readEndpoint, stateDir, tokenPath } from "../lib/auth.mjs";

const HELP = `dsh-rpc ${new Date().getUTCFullYear()} — drive a DeepSeek Harness session from the command line

USAGE
  dsh-rpc <command> [options] [args]

COMMANDS
  ping                      show bridge status, config and active runs
  discover                  list every RPC method with its params and result shape
  models                    list routable providers and models
  health [--wait MS]        unauthenticated liveness probe (with --wait, poll until ready)
  sessions [--limit N]      list Harness sessions
  create [--cwd DIR]        create a blank session
  ask <prompt...>           create/reuse a session, prompt it, wait for the turn
  prompt --session ID <p>   submit a prompt and return immediately
  wait --session ID         wait for the turn already running on a session
  cancel --session ID       cancel the in-flight turn
  history --session ID      show the recent event window
  call <method> [json]      raw JSON-RPC call (json params optional)
  env                       print the endpoint and token as shell exports

OPTIONS
  --cwd DIR                 working directory for a new session
  --session ID              reuse an existing session
  --preset NAME             agent preset for a new session
  --mode queue|steer        prompt delivery mode (default queue)
  --timeout MS              wait budget for ask/wait (default 600000)
  --limit N                 list/history size
  --wait MS                 health: keep polling the published endpoint until it answers
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

const BOOLEAN_FLAGS = new Set(["json", "stream", "help", "verbose"]);
const VALUE_FLAGS = new Set(["cwd", "session", "preset", "mode", "timeout", "limit", "wait", "url", "token"]);

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

function numberOf(flags, key) {
  if (flags[key] === undefined) return undefined;
  const value = Number(flags[key]);
  if (!Number.isFinite(value) || value <= 0) throw new UsageError(`--${key} must be a positive number`);
  return Math.floor(value);
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

function emitResult(result, flags) {
  if (flags.json) {
    print(JSON.stringify(result, null, 2));
  } else {
    if (result.text) print(result.text);
    else if (result.status !== "completed") note("(no assistant text)");
    if (flags.verbose && result.reason) note(`reason: ${JSON.stringify(result.reason)}`);
  }
  note(footer(result));
}

const DEFAULT_TURN_TIMEOUT_MS = 600000;

/** The client must out-wait the server's turn budget, or it aborts a live turn. */
function turnBudget(timeoutMs) {
  return (timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS) + 30_000;
}

async function runAsk(flags, positional) {
  const text = await readPrompt(positional);
  const params = { text };
  if (flags.cwd) params.cwd = flags.cwd;
  if (flags.session) params.sessionId = flags.session;
  if (flags.preset) params.agentPreset = flags.preset;
  if (flags.mode) params.mode = flags.mode;
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
    emitResult(result, flags);
    return exitCodeFor(result);
  }

  const result = await rpcCall("dsh.sessions.ask", params, budget);
  emitResult(result, flags);
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
      if (flags.preset) params.agentPreset = flags.preset;
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
      if (flags.mode) params.mode = flags.mode;
      const result = await rpcCall("dsh.sessions.prompt", params, options);
      print(flags.json ? JSON.stringify(result, null, 2) : result.requestId);
      return 0;
    }
    case "wait": {
      if (!flags.session) throw new UsageError("wait needs --session <id>");
      const params = { sessionId: flags.session };
      const timeout = numberOf(flags, "timeout");
      if (timeout) params.timeoutMs = timeout;
      const result = await rpcCall("dsh.sessions.wait", params, {
        ...options,
        timeoutMs: turnBudget(timeout),
      });
      emitResult(result, flags);
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
      const result = await rpcCall(method, params, options);
      print(JSON.stringify(result, null, 2));
      return 0;
    }
    case "env": {
      const endpoint = readEndpoint();
      const url = flags.url ?? process.env.DSH_RPC_URL ?? endpoint?.url;
      if (url) print(`export DSH_RPC_URL='${url}'`);
      else print("# no endpoint published yet — start the Harness once with the plugin enabled");
      print(`export DSH_RPC_TOKEN='$(cat "${tokenPath().replace(/\\/g, "/")}")'`);
      return 0;
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

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
    note(code === 3 ? `dsh-rpc: cannot reach the Harness (is it running?) — ${error?.message ?? error}` : `dsh-rpc: ${error?.message ?? error}`);
    if (error?.data) note(`  ${JSON.stringify(error.data)}`);
    await flushStdio();
    process.exit(code);
  });
