// End-to-end verification against a *running* Harness.
//
// Everything here goes through the same public client library an external agent
// would import (`lib/client.mjs`), so a green run proves the whole path:
// plugin → Host sessionController → HTTP carrier → JSON-RPC → caller.
//
// Usage: node test/e2e.mjs [--cwd <dir>] [--url <url>]
// Exit code 0 = every check passed, 1 = at least one failed.

import process from "node:process";
import { rpcCall, rpcStream } from "../lib/client.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const cwd = flag("cwd", process.cwd());
const url = flag("url", "");
const options = url ? { url } : {};

const results = [];

async function check(name, run) {
  const startedAt = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, ms: Date.now() - startedAt, detail });
    console.log(`✔ ${name} — ${Date.now() - startedAt}ms${detail ? ` · ${detail}` : ""}`);
    return true;
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - startedAt, error });
    console.log(`✘ ${name} — ${error?.message ?? error}`);
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ------------------------------------------------------------------ transport --

let sessionId = "";

await check("ping over the authenticated channel", async () => {
  const value = await rpcCall("dsh.ping", {}, options);
  assert(value?.plugin === "dsh-rpc-agent", "ping did not identify the plugin");
  return `${value.plugin} ${value.version}`;
});

await check("discover advertises the method catalog", async () => {
  const value = await rpcCall("dsh.discover", {}, options);
  const names = (value?.methods ?? []).map((entry) => entry.name);
  for (const required of ["dsh.sessions.ask", "dsh.sessions.wait", "dsh.sessions.cancel", "dsh.sessions.history"]) {
    assert(names.includes(required), `catalog is missing ${required}`);
  }
  return `${names.length} methods`;
});

await check("a wrong token is rejected with -32001", async () => {
  let failure = null;
  try {
    await rpcCall("dsh.ping", {}, { ...options, token: "0".repeat(32) });
  } catch (error) {
    failure = error;
  }
  assert(failure, "a bad token was accepted");
  assert(failure.code === -32001, `expected -32001, got ${failure.code}`);
  return "401";
});

await check("an unknown method is rejected with -32601", async () => {
  let failure = null;
  try {
    await rpcCall("dsh.nope", {}, options);
  } catch (error) {
    failure = error;
  }
  assert(failure, "an unknown method was accepted");
  assert(failure.code === -32601, `expected -32601, got ${failure.code}`);
  return "methodNotFound";
});

await check("invalid params are rejected with -32602", async () => {
  let failure = null;
  try {
    await rpcCall("dsh.sessions.ask", { text: "   " }, options);
  } catch (error) {
    failure = error;
  }
  assert(failure, "blank prompt text was accepted");
  assert(failure.code === -32602, `expected -32602, got ${failure.code}`);
  return "invalidParams";
});

// -------------------------------------------------------------------- sessions --

await check("models reads the Host catalog", async () => {
  const value = await rpcCall("dsh.models", {}, options);
  assert(Array.isArray(value?.groups), "modelCatalog groups were not forwarded");
  return `${value.groups.length} groups`;
});

await check("sessions.list reads the Host session index", async () => {
  const value = await rpcCall("dsh.sessions.list", { limit: 3 }, options);
  assert(typeof value?.total === "number", "list did not report a total");
  assert(value.items.length <= 3, "list ignored the limit");
  return `${value.total} sessions`;
});

await check("sessions.create opens a fresh session", async () => {
  const value = await rpcCall("dsh.sessions.create", { cwd }, options);
  sessionId = value?.sessionId ?? "";
  assert(sessionId.startsWith("session-"), "create did not return a session id");
  return sessionId;
});

await check("ask runs one turn and returns its text", async () => {
  const value = await rpcCall(
    "dsh.sessions.ask",
    { sessionId, text: "只回复两个字：收到", timeoutMs: 180000 },
    options,
  );
  assert(value?.status === "completed", `turn ended as ${value?.status}`);
  assert(typeof value.text === "string" && value.text.length > 0, "turn produced no text");
  return `turn ${value.turn} · ${value.usage?.outputTokens ?? "?"} out tokens`;
});

await check("ask continues the same conversation", async () => {
  const value = await rpcCall(
    "dsh.sessions.ask",
    { sessionId, text: "我刚才让你回复哪两个字？直接回答那两个字。", timeoutMs: 180000 },
    options,
  );
  assert(value?.turn >= 2, `expected a later turn, got ${value?.turn}`);
  assert(value.text.includes("收到"), `the follow-up lost the earlier turn: ${value.text.slice(0, 60)}`);
  return `turn ${value.turn} remembered`;
});

await check("history reads the snapshot without prompting", async () => {
  const value = await rpcCall("dsh.sessions.history", { sessionId, limit: 30 }, options);
  assert(value?.turn >= 2, "history did not report the turn count");
  assert(Array.isArray(value.records) && value.records.length > 0, "history was empty");
  assert(value.cursor >= 0, "history did not report a cursor");
  return `${value.records.length} records · cursor ${value.cursor}`;
});

// ------------------------------------------------------------------ long form --

await check("stream streams NDJSON progress for one prompt", async () => {
  const seen = new Set();
  let finalText = "";
  let sawResult = false;
  for await (const frame of rpcStream(
    { sessionId, text: "用一句话解释什么是 JSON-RPC。", timeoutMs: 180000 },
    options,
  )) {
    if (frame.type === "result") {
      sawResult = true;
      finalText = frame.text ?? "";
    }
    if (frame.type === "progress") {
      const inner = frame.frame ?? {};
      seen.add(inner.event?.type ?? inner.type ?? "progress");
    }
    if (frame.type === "error") throw new Error(frame.error?.message ?? "stream failed");
  }
  assert(sawResult, "the stream never sent a result frame");
  assert(finalText.length > 0, "the stream produced no final text");
  assert(seen.has("turn/start"), "the stream never reported turn/start");
  return `${seen.size} frame kinds`;
});

await check("cancel aborts a live turn", async () => {
  await rpcCall("dsh.sessions.prompt", {
    sessionId,
    text: "请逐行输出 1 到 3000 的数字，不要省略，也不要解释。",
  }, options);

  // Let the turn actually begin streaming before interrupting it; cancelling a
  // queued-but-not-yet-started prompt would prove nothing about the abort path.
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const cancelled = await rpcCall("dsh.sessions.cancel", { sessionId }, options);
  assert(cancelled?.accepted === true, "cancel was not accepted");

  const value = await rpcCall("dsh.sessions.wait", { sessionId, timeoutMs: 60000 }, options);
  assert(value?.reason?.kind === "aborted", `expected an aborted turn, got ${value?.reason?.kind}`);
  return `turn ${value.turn} aborted`;
});

await check("wait on an idle session reports the last turn's own status", async () => {
  const value = await rpcCall("dsh.sessions.wait", { sessionId, timeoutMs: 15000 }, options);
  assert(value?.status === "aborted", `expected the aborted status, got ${value?.status}`);
  return `turn ${value.turn} · ${value.status}`;
});

// -------------------------------------------------------------------- summary --

const failed = results.filter((entry) => !entry.ok);
console.log("");
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  for (const entry of failed) console.log(`  failed: ${entry.name} — ${entry.error?.stack ?? entry.error}`);
  process.exitCode = 1;
}
