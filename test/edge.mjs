// Edge-case regression suite for the dsh-rpc wire surface.
//
// Complements test/e2e.mjs: that file proves the happy paths, this one proves the
// unhappy ones — malformed envelopes, oversized bodies, notification semantics,
// parameter injection, unknown-session errors, and concurrent prompting.
//
// Run it against a live Harness (the plugin must be mounted):
//   node test/edge.mjs
// Exit code 0 only when every check passes.

import { readEndpoint, readTokenFromFile } from "../lib/auth.mjs";
import { rpcCall } from "../lib/client.mjs";

const endpoint = readEndpoint();
if (!endpoint?.url) {
  console.error("no endpoint.json — start the Harness with the dsh-rpc plugin enabled first");
  process.exit(3);
}
const base = endpoint.url.replace(/\/+$/, "");
const token = readTokenFromFile() ?? "";
const H = { "content-type": "application/json", authorization: `Bearer ${token}` };

let failed = 0;
let index = 0;

async function check(name, fn) {
  index += 1;
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    console.log(`✔ ${String(index).padStart(2, "0")} ${name} — ${ms}ms${detail ? ` · ${detail}` : ""}`);
  } catch (error) {
    failed += 1;
    const ms = Date.now() - started;
    console.log(`✘ ${String(index).padStart(2, "0")} ${name} — ${ms}ms · ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Raw HTTP that never throws on a non-2xx status. */
async function post(body, { headers = H, method = "POST", path = "" } = {}) {
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: method === "POST" && body !== undefined ? body : undefined,
    });
    const text = await response.text();
    return { status: response.status, text, json: safeParse(text) };
  } catch (error) {
    return { status: 0, text: "", networkError: error.cause?.code ?? error.message };
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function rpc(method, params, extra = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params, ...extra });
}

// ---------------------------------------------------------------- checks --

await check("oversized body answers 413 instead of resetting the socket", async () => {
  const big = rpc("dsh.ping", { pad: "x".repeat(2 * 1024 * 1024) });
  const res = await post(big);
  assert(!res.networkError, `socket failed: ${res.networkError}`);
  assert(res.status === 413, `expected 413, got ${res.status}`);
  assert(res.json?.error?.code === -32600, `expected -32600, got ${JSON.stringify(res.json?.error)}`);
  return `HTTP ${res.status}`;
});

await check("malformed JSON answers -32700", async () => {
  const res = await post("{not json");
  assert(res.status === 400, `expected 400, got ${res.status}`);
  assert(res.json?.error?.code === -32700, `expected -32700, got ${res.json?.error?.code}`);
  return "parseError";
});

await check("an empty batch is rejected", async () => {
  const res = await post("[]");
  assert(res.status === 400, `expected 400, got ${res.status}`);
  assert(res.json?.error?.code === -32600, `expected -32600, got ${res.json?.error?.code}`);
  return "invalidRequest";
});

await check("a mixed batch answers one result and one error", async () => {
  const res = await post(
    JSON.stringify([
      { jsonrpc: "2.0", id: "a", method: "dsh.ping", params: {} },
      { jsonrpc: "2.0", id: "b", method: "dsh.nope", params: {} },
    ]),
  );
  assert(res.status === 200, `expected 200, got ${res.status}`);
  assert(Array.isArray(res.json) && res.json.length === 2, `expected 2 answers, got ${JSON.stringify(res.json)}`);
  const byId = Object.fromEntries(res.json.map((entry) => [entry.id, entry]));
  assert(byId.a?.result?.ok === true, "the valid member did not answer");
  assert(byId.b?.error?.code === -32601, "the unknown method did not answer -32601");
  return "2/2";
});

await check("a batch of notifications answers 204", async () => {
  const res = await post(
    JSON.stringify([
      { jsonrpc: "2.0", method: "dsh.ping", params: {} },
      { jsonrpc: "2.0", method: "dsh.ping", params: {} },
    ]),
  );
  assert(res.status === 204, `expected 204, got ${res.status}`);
  assert(res.text === "", `expected an empty body, got ${res.text.slice(0, 80)}`);
  return "no content";
});

await check("a single notification answers 204", async () => {
  const res = await post(JSON.stringify({ jsonrpc: "2.0", method: "dsh.ping", params: {} }));
  assert(res.status === 204, `expected 204, got ${res.status}`);
  return "no content";
});

await check("an object id is rejected with -32600", async () => {
  const res = await post(JSON.stringify({ jsonrpc: "2.0", id: { bad: 1 }, method: "dsh.ping", params: {} }));
  assert(res.status === 200, `expected 200, got ${res.status}`);
  assert(res.json?.error?.code === -32600, `expected -32600, got ${res.json?.error?.code}`);
  return "invalidRequest";
});

await check("an unsupported jsonrpc version is rejected with -32600", async () => {
  const res = await post(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "dsh.ping", params: {} }));
  assert(res.json?.error?.code === -32600, `expected -32600, got ${res.json?.error?.code}`);
  return "invalidRequest";
});

await check("positional params carry one object", async () => {
  const ok = await post(rpc("dsh.ping", [{}]));
  assert(ok.json?.result?.ok === true, `expected a result, got ${JSON.stringify(ok.json)}`);
  const tooMany = await post(rpc("dsh.ping", [{}, {}]));
  assert(tooMany.json?.error?.code === -32602, `expected -32602, got ${tooMany.json?.error?.code}`);
  return "1 object ok, 2 rejected";
});

await check("an unknown method reports the catalog", async () => {
  const res = await post(rpc("dsh.nope", {}));
  const error = res.json?.error;
  assert(error?.code === -32601, `expected -32601, got ${error?.code}`);
  assert(Array.isArray(error?.data?.available) && error.data.available.length >= 10, "no method catalog in data");
  return `${error.data.available.length} methods`;
});

await check("the X-DSH-RPC-Token header is accepted", async () => {
  const res = await post(rpc("dsh.ping", {}), { headers: { "content-type": "application/json", "x-dsh-rpc-token": token } });
  assert(res.json?.result?.ok === true, `expected a result, got ${JSON.stringify(res.json)}`);
  return "header auth";
});

await check("a wrong token answers 401 with a challenge", async () => {
  const res = await post(rpc("dsh.ping", {}), { headers: { "content-type": "application/json", authorization: "Bearer nope" } });
  assert(res.status === 401, `expected 401, got ${res.status}`);
  assert(res.json?.error?.code === -32001, `expected -32001, got ${res.json?.error?.code}`);
  return "unauthorized";
});

await check("GET on the RPC path answers 405", async () => {
  const res = await post(undefined, { method: "GET" });
  assert(res.status === 405, `expected 405, got ${res.status}`);
  return "method not allowed";
});

await check("HEAD on /health answers without a body", async () => {
  const response = await fetch(`${base}/health`, { method: "HEAD" });
  assert(response.status === 200, `expected 200, got ${response.status}`);
  const text = await response.text();
  assert(text === "", `expected no body, got ${text.slice(0, 40)}`);
  return "HEAD ok";
});

await check("a whitespace-only prompt is rejected before creating a session", async () => {
  const res = await post(rpc("dsh.sessions.ask", { text: "   " }));
  assert(res.json?.error?.code === -32602, `expected -32602, got ${res.json?.error?.code}`);
  return "invalidParams";
});

await check("wait on an unknown session answers -32003", async () => {
  const res = await post(rpc("dsh.sessions.wait", { sessionId: "session-does-not-exist" }));
  assert(res.json?.error?.code === -32003, `expected -32003, got ${JSON.stringify(res.json?.error)}`);
  return "notFound";
});

await check("history on an unknown session answers -32003", async () => {
  const res = await post(rpc("dsh.sessions.history", { sessionId: "session-does-not-exist" }));
  assert(res.json?.error?.code === -32003, `expected -32003, got ${JSON.stringify(res.json?.error)}`);
  return "notFound";
});

await check("cancel on a fresh idle session is idempotent", async () => {
  const created = await rpcCall("dsh.sessions.create", {});
  const first = await rpcCall("dsh.sessions.cancel", { sessionId: created.sessionId });
  const second = await rpcCall("dsh.sessions.cancel", { sessionId: created.sessionId });
  assert(first.accepted === true && second.accepted === true, "cancel is not idempotent");
  return created.sessionId;
});

await check("internal-only options cannot be injected through params", async () => {
  const res = await post(rpc("dsh.sessions.ask", { text: "只回复两个字：边界", onEvent: 1, signal: "boom" }));
  assert(!res.networkError, `socket failed: ${res.networkError}`);
  assert(
    res.json?.result?.status === "completed",
    `injected options broke the call: ${JSON.stringify(res.json?.error ?? res.json?.result?.status)}`,
  );
  return "ignored";
});

await check("an out-of-range timeout is clamped, not rejected", async () => {
  const started = Date.now();
  const res = await post(rpc("dsh.sessions.ask", { text: "只回复两个字：钳制", timeoutMs: 1 }));
  assert(res.json?.result, `expected a result, got ${JSON.stringify(res.json?.error)}`);
  assert(Date.now() - started >= 1000, "the 1000ms floor was not applied");
  return `${res.json.result.status} in ${Date.now() - started}ms`;
});

await check("create without a cwd reports the directory the Host attached", async () => {
  const created = await rpcCall("dsh.sessions.create", {});
  assert(typeof created.cwd === "string" && created.cwd.length > 0, `expected a cwd, got ${JSON.stringify(created.cwd)}`);
  return created.cwd;
});

await check("a fractional limit is rejected instead of silently rounded", async () => {
  const res = await post(rpc("dsh.sessions.list", { limit: 2.5 }));
  assert(res.json?.error?.code === -32602, `expected -32602, got ${JSON.stringify(res.json?.error ?? res.json?.result)}`);
  return "invalidParams";
});

await check("an explicit limit still caps the page", async () => {
  const value = await rpcCall("dsh.sessions.list", { limit: 3 });
  assert(value.items.length <= 3, `limit ignored: ${value.items.length} items`);
  return `${value.items.length} of ${value.total}`;
});

await check("two concurrent asks on one session are refused, not crossed", async () => {
  // Turn attribution is only sound while one bridge run owns the only prompt in
  // flight; the second prompting run must fail fast instead of returning the
  // first run's answer.
  const created = await rpcCall("dsh.sessions.create", {});
  const sessionId = created.sessionId;
  const settled = await Promise.allSettled([
    rpcCall("dsh.sessions.ask", { sessionId, text: "只回复一个字：甲" }),
    rpcCall("dsh.sessions.ask", { sessionId, text: "只回复一个字：乙" }),
  ]);
  const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
  const rejected = settled.filter((entry) => entry.status === "rejected");
  assert(fulfilled.length === 1 && rejected.length === 1, `expected 1 ok + 1 refused, got ${settled.length - rejected.length} ok`);
  assert(rejected[0].reason?.code === -32004, `expected busy (-32004), got ${rejected[0].reason?.code}`);
  return `turn ${fulfilled[0].value.turn} answered, second refused`;
});

console.log(
  failed === 0
    ? `\n${index}/${index} edge checks passed`
    : `\n${index - failed}/${index} edge checks passed, ${failed} failed`,
);
process.exitCode = failed === 0 ? 0 : 1;
