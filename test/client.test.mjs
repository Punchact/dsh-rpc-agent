// Client-side stale-endpoint behaviour, exercised without a live Harness.
//
// The endpoint file is the only thing a client reads, so a temporary $DSH_HOME is
// enough to reproduce a restart: publish a dead port, call, republish the live
// one. `node --test` cannot be used in this workspace (it forks a child process
// and the sandbox forbids piped stdio), so run this file directly.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = join(tmpdir(), `dsh-rpc-client-test-${process.pid}`);
mkdirSync(join(home, "dsh-rpc"), { recursive: true });
process.env.DSH_HOME = home;
process.env.DSH_RPC_TOKEN = "client-test-token-0123456789";
delete process.env.DSH_RPC_URL;

const { rpcCall } = await import("../lib/client.mjs");
const { transportCode } = await import("../lib/transport.mjs");

// These shapes differ per platform, which is exactly why the extraction is its
// own module: a socket is not needed to pin the behaviour down.
test("the transport code is recovered from the undici cause chain", () => {
  // Linux: the socket dies mid-flight and no system errno survives anywhere.
  assert.equal(
    transportCode(new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } })),
    "ECONNRESET",
  );
  // Windows: the same undici code, but nesting the real errno one level deeper.
  assert.equal(
    transportCode(
      new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET", cause: { code: "ECONNRESET" } } }),
    ),
    "ECONNRESET",
  );
  // Happy eyeballs reports each loopback attempt inside an AggregateError.
  assert.equal(
    transportCode(
      new TypeError("fetch failed", {
        cause: new AggregateError([
          Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
          Object.assign(new Error("unreachable"), { code: "EHOSTUNREACH" }),
        ]),
      }),
    ),
    "ECONNREFUSED",
  );
  assert.equal(
    transportCode(new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })),
    "ETIMEDOUT",
  );
  // A code we cannot interpret is reported verbatim instead of guessed at.
  assert.equal(
    transportCode(new TypeError("fetch failed", { cause: { code: "UND_ERR_ABORTED" } })),
    "UND_ERR_ABORTED",
  );
  assert.equal(transportCode(new Error("plain failure")), undefined);
});

const endpointFile = join(home, "dsh-rpc", "endpoint.json");

function publishEndpoint(url, extra = {}) {
  writeFileSync(
    endpointFile,
    `${JSON.stringify(
      {
        url,
        origin: url.replace(/\/dsh-rpc$/, ""),
        path: "/dsh-rpc",
        version: "0.0.0-test",
        plugin: "dsh-rpc",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function listen(handler, { onConnection } = {}) {
  const server = createServer(handler);
  if (onConnection) server.on("connection", onConnection);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/dsh-rpc` };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

/** A port nobody is listening on: bind, read the number, release it. */
async function deadPort() {
  const { server, url } = await listen(() => {});
  await close(server);
  return Number(new URL(url).port);
}

after(() => rmSync(home, { recursive: true, force: true }));

test("a refused port is retried once after the endpoint is republished", async () => {
  const dead = await deadPort();
  publishEndpoint(`http://127.0.0.1:${dead}/dsh-rpc`);

  let hits = 0;
  const { server, url } = await listen((request, response) => {
    hits += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });

  try {
    const pending = rpcCall("dsh.ping", {}, { timeoutMs: 8000 });
    // Republish before the refused handshake settles. That interleaving is the
    // restart race the retry exists for: the caller read a port that was valid
    // when it started.
    publishEndpoint(url);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(hits, 1, "the retry must not deliver the request twice");
  } finally {
    await close(server);
  }
});

test("a reset connection is reported, never replayed", async () => {
  let connections = 0;
  const { server, url } = await listen(() => {}, {
    onConnection: (socket) => {
      connections += 1;
      socket.destroy();
    },
  });
  publishEndpoint(url);

  try {
    await assert.rejects(
      () => rpcCall("dsh.ping", {}, { timeoutMs: 8000 }),
      (error) => {
        assert.equal(error.code, "ECONNRESET", "the transport code must survive the wrap");
        return true;
      },
    );
    // Bytes may have reached the server, so the request must never be resent.
    assert.equal(connections, 1);
  } finally {
    await close(server);
  }
});

test("an explicitly supplied url is never retried", async () => {
  const dead = await deadPort();
  let hits = 0;
  const { server, url } = await listen((request, response) => {
    hits += 1;
    response.end("{}");
  });
  publishEndpoint(url);

  try {
    await assert.rejects(
      () => rpcCall("dsh.ping", {}, { url: `http://127.0.0.1:${dead}/dsh-rpc`, timeoutMs: 8000 }),
      (error) => {
        assert.equal(error.code, "ECONNREFUSED");
        return true;
      },
    );
    assert.equal(hits, 0, "the caller named the address, so no second address is tried");
  } finally {
    await close(server);
  }
});

test("a second failure that is not a refused handshake keeps its own meaning", async () => {
  const dead = await deadPort();
  publishEndpoint(`http://127.0.0.1:${dead}/dsh-rpc`);

  const { server, url } = await listen((request, response) => {
    response.statusCode = 401;
    response.end("unauthorized");
  });

  try {
    const pending = rpcCall("dsh.ping", {}, { timeoutMs: 8000 });
    publishEndpoint(url);
    // The retry reached a live server that said 401. Reporting that as "nothing
    // is listening" would send the reader looking for a restart that never
    // happened.
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, -32001);
      assert.doesNotMatch(error.message, /nothing is listening/);
      return true;
    });
  } finally {
    await close(server);
  }
});

test("a caller signal does not disable the request timeout", async () => {
  const { server, url } = await listen((_request, response) => {
    setTimeout(() => response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })), 250);
  });
  publishEndpoint(url);
  const controller = new AbortController();

  try {
    const started = Date.now();
    await assert.rejects(
      () => rpcCall("dsh.ping", {}, { timeoutMs: 40, signal: controller.signal }),
      (error) => error.name === "TimeoutError" || error.name === "AbortError",
    );
    assert.ok(Date.now() - started < 220, "timeout must win before the server responds");
  } finally {
    controller.abort();
    await close(server);
  }
});

test("non-success HTTP and malformed success envelopes are errors", async () => {
  const cases = [
    [503, { message: "fixture unavailable" }, -32000],
    [200, { jsonrpc: "2.0", id: 1, result: { ok: true } }, null],
    [200, { jsonrpc: "2.0", id: 2, result: { ok: true } }, -32000],
    [200, { jsonrpc: "2.0", id: 1 }, -32000],
    [200, { jsonrpc: "2.0", id: 1, result: {}, error: { code: -1, message: "bad" } }, -32000],
    [200, { jsonrpc: "2.0", id: 1, error: { message: "missing code" } }, -32000],
  ];
  for (const [status, payload, expectedCode] of cases) {
    const { server, url } = await listen((_request, response) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
    });
    publishEndpoint(url);
    try {
      if (expectedCode === null) {
        assert.deepEqual(await rpcCall("dsh.ping", {}), { ok: true });
      } else {
        await assert.rejects(
          () => rpcCall("dsh.ping", {}),
          (error) => error.code === expectedCode && error.status === status,
        );
      }
    } finally {
      await close(server);
    }
  }
});

test("an unchanged dead endpoint explains the restart and names the pid", async () => {
  const dead = await deadPort();
  publishEndpoint(`http://127.0.0.1:${dead}/dsh-rpc`, {
    pid: 4242,
    startedAt: "2026-01-02T03:04:05.000Z",
  });

  await assert.rejects(
    () => rpcCall("dsh.ping", {}, { timeoutMs: 8000 }),
    (error) => {
      assert.equal(error.code, "ECONNREFUSED");
      assert.match(error.message, /nothing is listening/);
      assert.match(error.message, /pid 4242/);
      assert.match(error.message, /health --wait/);
      return true;
    },
  );
});
