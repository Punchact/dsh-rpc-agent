// Client-side stale-endpoint behaviour, exercised without a live Harness.
//
// The endpoint file is the only thing a client reads, so a temporary $DSH_HOME is
// enough to reproduce a restart: publish a dead port, call, republish the live
// one. `node --test` cannot be used in this workspace (it forks a child process
// and the sandbox forbids piped stdio), so run this file directly.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";

import { closeServer as close, deadSafePort as deadPort, listenSafe as listen } from "./helpers/stub-server.mjs";

const home = join(tmpdir(), `dsh-rpc-client-test-${process.pid}`);
mkdirSync(join(home, "dsh-rpc"), { recursive: true });
process.env.DSH_HOME = home;
process.env.DSH_RPC_TOKEN = "client-test-token-0123456789";
delete process.env.DSH_RPC_URL;

const { rpcCall, RETRYABLE_CONNECT_CODES } = await import("../dist/lib/client.mjs");
const { FETCH_BLOCKED_PORTS, hasBadPortCause, isFetchBlockedPort, transportCode } = await import(
  "../dist/lib/transport.mjs"
);
const { CODE, RpcError, isRpcError } = await import("../dist/lib/protocol.mjs");

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
  // A code we cannot interpret is reported verbatim instead of guessed at, even
  // if a deeper cause happens to say "bad port".
  assert.equal(
    transportCode(new TypeError("fetch failed", { cause: { code: "UND_ERR_ABORTED" } })),
    "UND_ERR_ABORTED",
  );
  assert.equal(
    transportCode(Object.assign(new Error("custom"), { code: "ERR_CUSTOM", cause: new Error("bad port") })),
    "ERR_CUSTOM",
  );
  assert.equal(transportCode(new Error("plain failure")), undefined);
});

test("a blocked port is named instead of left as an undefined code", async () => {
  // fetch refuses the ports the standard calls "bad" (5060, 6667, ...) before it
  // opens a socket, so no errno survives anywhere in the chain — only a cause
  // whose message is `bad port`. That is not hypothetical here: the bridge does
  // not choose its port, the Host's Web server does, and a Host that lands on
  // one of these would leave every out-of-process caller with "fetch failed".
  assert.equal(transportCode(new TypeError("fetch failed", { cause: new Error("bad port") })), "EBADPORT");
  assert.equal(isFetchBlockedPort(5060), true);
  assert.equal(isFetchBlockedPort("6667"), true);
  assert.equal(isFetchBlockedPort("5060abc"), false);
  assert.equal(isFetchBlockedPort(12345), false);
  assert.equal(isFetchBlockedPort(null), false);

  // Unchanged blocked endpoint: must rethrow EBADPORT directly without "nothing is listening".
  publishEndpoint("http://127.0.0.1:5060/dsh-rpc");
  await assert.rejects(rpcCall("dsh.ping", {}, { timeoutMs: 8000 }), (error) => {
    assert.equal(error.code, "EBADPORT");
    assert.match(error.message, /bad port/);
    assert.match(error.message, /--url/);
    assert.doesNotMatch(error.message, /nothing is listening/);
    return true;
  });

  // Stale-endpoint race where the previous run happened to bind a blocked port and
  // restarted onto a valid one (`second.url !== first.url`): EBADPORT never opened a
  // socket, so one replay to the new URL is safe and recovers the call.
  let hits = 0;
  const live = await listen((_request, response) => {
    hits += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });
  publishEndpoint("http://127.0.0.1:5060/dsh-rpc");

  try {
    const pending = rpcCall("dsh.ping", {}, { timeoutMs: 8000 });
    publishEndpoint(live.url);
    const res = await pending;
    assert.deepEqual(res, { ok: true });
    assert.equal(hits, 1, "EBADPORT replays once when endpoint.json moved to a new URL");
  } finally {
    await close(live.server);
  }
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

after(() => rmSync(home, { recursive: true, force: true }));

test("listenSafe skips fetch-blocked ports and closes rejected sockets deterministically", async () => {
  const ports = [5060, 6667, 54321];
  const closed = [];
  let idx = 0;
  const res = await listen(() => {}, {
    createServerImpl() {
      const assigned = ports[idx++];
      return {
        listen(_p, _h, cb) {
          cb();
        },
        address() {
          return { port: assigned };
        },
        close(cb) {
          closed.push(assigned);
          cb();
        },
      };
    },
  });
  assert.equal(res.port, 54321);
  assert.deepEqual(closed, [5060, 6667]);
});

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

test("protocol & transport exports preserve runtime guards and invariants", () => {
  assert.equal(FETCH_BLOCKED_PORTS instanceof Set, true);
  assert.equal(FETCH_BLOCKED_PORTS.has(5060), true);
  assert.equal(FETCH_BLOCKED_PORTS.has(6667), true);
  assert.equal(hasBadPortCause(new Error("fetch failed", { cause: new Error("bad port") })), true);
  assert.equal(RETRYABLE_CONNECT_CODES instanceof Set, true);
  assert.equal(RETRYABLE_CONNECT_CODES.has("ECONNREFUSED"), true);

  const err = new RpcError(CODE.invalidParams, "bad");
  assert.equal(isRpcError(err), true);
  assert.equal(isRpcError(new Error("plain")), false);
  assert.equal(isRpcError(null), false);
});

test("transportCode, FETCH_BLOCKED_PORTS, and client contracts reject ill-typed uses at tsc compile time", () => {
  const repoRoot = resolve(import.meta.dirname, "..");
  const configPath = resolve(repoRoot, "tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    repoRoot,
  );
  const validFile = resolve(repoRoot, "src/lib/__typecheck_valid_probe__.mts");
  const badFile = resolve(repoRoot, "src/lib/__typecheck_bad_probe__.mts");

  const validSource = `
import { CODE, RpcError, isRpcError } from "./protocol.mjs";
import { FETCH_BLOCKED_PORTS, isFetchBlockedPort, transportCode, type TransportCode } from "./transport.mjs";
import { RETRYABLE_CONNECT_CODES, rpcCall } from "./client.mjs";

const a: boolean = isFetchBlockedPort(5060);
const b: boolean = isFetchBlockedPort("6667");
const c: boolean = FETCH_BLOCKED_PORTS.has(5060);
const d: TransportCode = transportCode(new Error("boom"));
const e: boolean = RETRYABLE_CONNECT_CODES.has("ECONNREFUSED");
const f: boolean = isRpcError(new RpcError(CODE.internal, "x"));
void a; void b; void c; void d; void e; void f; void rpcCall;
`;

  const badSource = `
import { FETCH_BLOCKED_PORTS, isFetchBlockedPort, transportCode } from "./transport.mjs";
import { RETRYABLE_CONNECT_CODES } from "./client.mjs";

const p1 = isFetchBlockedPort("5060abc");
FETCH_BLOCKED_PORTS.add(1234);
const p2 = FETCH_BLOCKED_PORTS.has("5060");
const narrow: "ECONNREFUSED" | "UNKNOWN" = transportCode(new Error("boom"));
RETRYABLE_CONNECT_CODES.add("ECONNRESET");
void p1; void p2; void narrow;
`;

  const host = ts.createCompilerHost(parsed.options);
  const origGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const resolved = resolve(fileName);
    if (resolved === validFile) return ts.createSourceFile(fileName, validSource, languageVersion);
    if (resolved === badFile) return ts.createSourceFile(fileName, badSource, languageVersion);
    return origGetSourceFile(fileName, languageVersion, ...rest);
  };

  const program = ts.createProgram([validFile, badFile], parsed.options, host);
  const validDiags = ts.getPreEmitDiagnostics(program, program.getSourceFile(validFile));
  assert.equal(
    validDiags.length,
    0,
    `valid type-check probe should compile cleanly, got: ${validDiags.map((d) => `${d.code}:${ts.flattenDiagnosticMessageText(d.messageText, " ")}`).join("; ")}`,
  );

  const badDiags = ts.getPreEmitDiagnostics(program, program.getSourceFile(badFile));
  const messages = badDiags.map((d) => `TS${d.code}:${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  const summary = messages.join(" | ");
  assert.ok(badDiags.length >= 5, `expected >= 5 tsc errors, got ${badDiags.length}: ${summary}`);
  assert.ok(messages.some((m) => m.includes("5060abc")), `missing 5060abc diagnostic: ${summary}`);
  assert.ok(messages.some((m) => m.includes("ReadonlySet<number>")), `missing ReadonlySet<number> diagnostic: ${summary}`);
  assert.ok(messages.some((m) => m.includes("ReadonlySet<string>")), `missing ReadonlySet<string> diagnostic: ${summary}`);
  assert.ok(messages.some((m) => m.includes("TransportCode")), `missing TransportCode diagnostic: ${summary}`);
});
