// `waitForTurn()` is the fix for the transport ceiling: one request cannot stay
// quiet for more than ~300 s (Node's fetch `headersTimeout`), so a patient wait
// has to be a loop of short ones. These tests drive the loop against a stub
// bridge over real HTTP, because the failure they prevent lived in the transport.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { MAX_WAIT_SLICE_MS, WAIT_SLICE_MS, waitForTurn } from "../lib/client.mjs";

const TOKEN = "test-token";

/**
 * Serve `script` one entry per request, then repeat the last entry. Each entry is
 * the JSON-RPC `result` to return.
 */
async function stubBridge(script) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push(body);
      const index = Math.min(calls.length - 1, script.length - 1);
      const result = script[index];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    calls,
    url: `http://127.0.0.1:${port}/dsh-rpc`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("a long wait is a loop of short ones, not one long request", async () => {
  const bridge = await stubBridge([
    { sessionId: "session-a", status: "timeout", timedOut: true, cursor: 10 },
    { sessionId: "session-a", status: "timeout", timedOut: true, cursor: 20 },
    { sessionId: "session-a", status: "completed", text: "done", cursor: 30, turn: 1, timedOut: false },
  ]);
  try {
    const result = await waitForTurn("session-a", {
      url: bridge.url,
      token: TOKEN,
      timeoutMs: 60_000,
      sliceMs: 1_000,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "done");
    assert.equal(result.slices, 3, "three slices, not one 60 s request");
    assert.equal(bridge.calls.length, 3);
    for (const call of bridge.calls) {
      assert.equal(call.method, "dsh.sessions.wait");
      assert.equal(call.params.sessionId, "session-a");
    }
    // Every slice must stay under the transport ceiling and under the caller's
    // slice hint; the last one may be shorter.
    assert.deepEqual(
      bridge.calls.map((call) => call.params.timeoutMs),
      [1_000, 1_000, 1_000],
    );
    assert.ok(result.waitedMs >= 0);
  } finally {
    await bridge.close();
  }
});

test("the loop stops when the caller's budget is spent, and says it timed out", async () => {
  const bridge = await stubBridge([
    { sessionId: "session-b", status: "timeout", timedOut: true, cursor: 1 },
  ]);
  try {
    const started = Date.now();
    const result = await waitForTurn("session-b", {
      url: bridge.url,
      token: TOKEN,
      // Both values are floored at 1 s, so this loops about twice and returns.
      timeoutMs: 2_000,
      sliceMs: 1_000,
    });
    assert.equal(result.status, "timeout");
    assert.equal(result.timedOut, true);
    assert.ok(bridge.calls.length >= 2, "more than one slice before giving up");
    assert.ok(Date.now() - started >= 1_900, "it actually waited its budget");
    assert.equal(result.slices, bridge.calls.length);
  } finally {
    await bridge.close();
  }
});

test("a result that is not a timeout ends the loop immediately", async () => {
  const bridge = await stubBridge([{ sessionId: "session-c", status: "completed", text: "already" }]);
  try {
    const result = await waitForTurn("session-c", { url: bridge.url, token: TOKEN, timeoutMs: 60_000 });
    assert.equal(result.status, "completed");
    assert.equal(result.slices, 1, "no second request when the first one answers");
    assert.equal(bridge.calls.length, 1);
  } finally {
    await bridge.close();
  }
});

test("the default slice stays well clear of the transport ceiling", async () => {
  const bridge = await stubBridge([{ sessionId: "session-d", status: "completed", text: "quick" }]);
  try {
    await waitForTurn("session-d", { url: bridge.url, token: TOKEN, timeoutMs: 600_000 });
    assert.equal(WAIT_SLICE_MS, 120_000, "the default is two minutes, not four");
    assert.equal(bridge.calls[0].params.timeoutMs, 120_000);
  } finally {
    await bridge.close();
  }
});

test("a slice hint above the ceiling is clamped, never forwarded", async () => {
  const bridge = await stubBridge([{ sessionId: "session-e", status: "completed", text: "quick" }]);
  try {
    // A caller may ask for anything; one response still cannot stay quiet for
    // more than the ceiling, so the hint must not reach the wire unchanged.
    await waitForTurn("session-e", {
      url: bridge.url,
      token: TOKEN,
      timeoutMs: 3_600_000,
      sliceMs: 900_000,
    });
    assert.equal(bridge.calls[0].params.timeoutMs, MAX_WAIT_SLICE_MS);
    assert.equal(MAX_WAIT_SLICE_MS, 240_000);
  } finally {
    await bridge.close();
  }
});
