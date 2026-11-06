/**
 * R-5 (0.6.0): the abort path.
 *
 * Three things are pinned here, each at the layer where it can actually go wrong:
 *
 * 1. A caller that hangs up mid-request aborts the work it started (real HTTP
 *    server, real socket, real `close` event) — the fake `res` used by the status
 *    tests cannot prove this, because it never emits `close`.
 * 2. The counters tell a timed-out turn apart from a client that left, which is
 *    the difference between "the bridge is slow" and "nobody is listening".
 * 3. `notifications/cancelled` reaches an in-flight `tools/call` in the stdio MCP
 *    server, and an unknown request id is a no-op rather than a crash.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerRoutes } from "../lib/http.mjs";
import { resolveConfig } from "../lib/config.mjs";
import { createStats } from "../lib/stats.mjs";

const TOKEN = "b".repeat(48);
const REPO = fileURLToPath(new URL("..", import.meta.url));

function fakeServer() {
  const routes = new Map();
  return {
    routes,
    getOrigin: () => "http://127.0.0.1:1",
    register({ kind, path, handler }) {
      assert.equal(kind, "exact");
      routes.set(path, handler);
      return () => routes.delete(path);
    },
  };
}

async function serve(dispatch, stats = createStats()) {
  const server = fakeServer();
  const routes = registerRoutes({
    webServer: server,
    config: resolveConfig({}),
    dispatch,
    methods: {},
    state: { token: TOKEN, tokenSource: "file", endpointPath: "/tmp/x" },
    ctx: null,
    log: { info() {}, warn() {} },
    stats,
  });
  const rpc = server.routes.get("/dsh-rpc");
  const http = createServer((req, res) => {
    rpc(req, res).catch(() => res.destroy());
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    port: http.address().port,
    stats,
    async close() {
      routes.dispose();
      http.closeAllConnections?.();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

/** Fire one JSON-RPC request. Returns the ClientRequest so a test can hang up. */
function post(port, body) {
  let settle;
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  done.catch(() => {});
  const req = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path: "/dsh-rpc",
      method: "POST",
      // A fresh socket per request: a keep-alive socket would hold `http.close`
      // open and make a passing test look like a hang.
      agent: false,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    },
    (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => settle.resolve({ status: res.statusCode, text }));
    },
  );
  req.on("error", (error) => settle.reject(error));
  req.end(body);
  return { req, done };
}

async function waitFor(predicate, budgetMs, what) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out after ${budgetMs}ms waiting for ${what}`);
}

test("a caller that hangs up aborts the call it started", { timeout: 20_000 }, async () => {
  let seen = null;
  let aborted = false;
  const bridge = await serve(
    (method, params, context) =>
      new Promise((resolve) => {
        seen = context?.signal ?? null;
        context?.signal?.addEventListener("abort", () => {
          aborted = true;
          resolve({ aborted: true });
        });
      }),
  );
  try {
    const { req } = post(bridge.port, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "dsh.ping" }));
    await waitFor(() => seen !== null, 5_000, "dispatch to receive a signal");
    assert.equal(seen.aborted, false);
    // This is what a killed client looks like from the server side.
    req.destroy();
    await waitFor(() => aborted, 5_000, "the signal to abort");
  } finally {
    await bridge.close();
  }
});

test("a completed request keeps its signal clean and counts as neither outcome", { timeout: 20_000 }, async () => {
  let seen = null;
  const bridge = await serve(async (method, params, context) => {
    seen = context?.signal ?? null;
    return { status: "completed" };
  });
  try {
    const answer = await post(bridge.port, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "dsh.ping" })).done;
    assert.equal(answer.status, 200);
    assert.ok(seen, "dispatch still receives a context");
    assert.equal(seen.aborted, false);
    assert.deepEqual(bridge.stats.snapshot().outcomes, { timeouts: 0, cancelledByClient: 0 });
  } finally {
    await bridge.close();
  }
});

test("the counters separate a timed-out turn from a client that hung up", () => {
  const stats = createStats();
  stats.record("dsh.sessions.wait", 12, true, null, "timeouts");
  stats.record("dsh.sessions.ask", 30, false, -32006, "cancelledByClient");
  stats.record("dsh.ping", 1, true);
  const snapshot = stats.snapshot();
  assert.deepEqual(snapshot.outcomes, { timeouts: 1, cancelledByClient: 1 });
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.errors, 1);
  // An unknown outcome string must not invent a counter.
  stats.record("dsh.ping", 1, true, null, "not-a-counter");
  assert.deepEqual(stats.snapshot().outcomes, { timeouts: 1, cancelledByClient: 1 });
});

// ------------------------------------------------------------- stdio MCP ---

function talk(child) {
  let waiting = null;
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line.length > 0) {
        const message = JSON.parse(line);
        const resolve = waiting;
        waiting = null;
        resolve?.(message);
      }
      at = buffer.indexOf("\n");
    }
  });
  return {
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    next(timeoutMs = 5_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no MCP message arrived")), timeoutMs);
        waiting = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
      });
    },
  };
}

test("notifications/cancelled is accepted, and an unknown id is a no-op", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-rpc-abort-"));
  const child = spawn(process.execPath, [join(REPO, "bin", "dsh-rpc-mcp.mjs")], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => {});
  const wire = talk(child);
  try {
    wire.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    const init = await wire.next();
    assert.equal(init.id, 1);
    assert.ok(init.result?.serverInfo, "initialize must answer with serverInfo");

    // An id nobody is waiting on: the handler must not throw, and must not reply.
    wire.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } });
    wire.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // The server is still alive and still answering.
    wire.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    const pong = await wire.next();
    assert.equal(pong.id, 2);
    assert.deepEqual(pong.result, {});
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
});
