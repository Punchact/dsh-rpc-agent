/**
 * `/status` and the route-mounting contract.
 *
 * These tests never touch a Host: `registerRoutes` only needs the four things it
 * is handed, so a fake web server is enough to pin the behaviour that matters —
 * the payload stays aggregate-only, and a second generation of the plugin can
 * take over routes that a previous generation left mounted.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { registerRoutes } from "../lib/http.mjs";
import { resolveConfig } from "../lib/config.mjs";
import { createStats } from "../lib/stats.mjs";

const TOKEN = "a".repeat(48);

function fakeServer() {
  const routes = new Map();
  return {
    routes,
    getOrigin: () => "http://127.0.0.1:3820",
    register({ since, kind, path, handler }) {
      assert.equal(kind, "exact", "the bridge only mounts exact routes");
      if (routes.has(path)) throw new Error(`webserver: duplicate exact route "${path}"`);
      routes.set(path, handler);
      return () => routes.delete(path);
    },
    failOn: null,
  };
}

function fakeReq({ method = "GET", address = "127.0.0.1", headers = {} } = {}) {
  return { method, url: "/dsh-rpc/status", headers, socket: { remoteAddress: address } };
}

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(body) {
      if (body) this.body += body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

const config = resolveConfig({});

function harness({ server = fakeServer(), stats = createStats({ startedAt: Date.now() - 4000, pid: 4242 }) } = {}) {
  const methods = {
    ping: async () => ({
      origin: "http://127.0.0.1:3820",
      pid: 4242,
      node: "v24.21.0",
      config: { allowRemote: false },
      state: { tokenSource: "file", endpointPath: "C:/Users/x/.dsh/dsh-rpc/endpoint.json" },
      activeRuns: [{ sessionId: "session-secret", runId: "abcdef1234567890", prompt: true, ageMs: 1200 }],
    }),
  };

  return {
    server,
    stats,
    routes: registerRoutes({
      webServer: server,
      config,
      dispatch: async () => ({ ok: true }),
      methods,
      state: { token: TOKEN, tokenSource: "file", endpointPath: "C:/Users/x/.dsh/dsh-rpc/endpoint.json" },
      ctx: null,
      log: { info() {}, warn() {} },
      stats,
    }),
  };
}

test("the status route answers loopback with an aggregate-only payload", async () => {
  const { server, routes } = harness();
  try {
    const res = fakeRes();
    await server.routes.get("/dsh-rpc/status")(fakeReq(), res);

    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.plugin, "dsh-rpc-agent");
    assert.equal(body.origin, "http://127.0.0.1:3820");
    assert.equal(body.path, "/dsh-rpc");
    assert.equal(body.pid, 4242);
    assert.equal(body.tokenSource, "file");
    assert.equal(body.startedAt, new Date(body.startedAt).toISOString());
    assert.ok(body.servedForMs >= 4000, "uptime is measured from the stats start");
    assert.deepEqual(body.routes, {
      rpc: "/dsh-rpc",
      stream: "/dsh-rpc/stream",
      health: "/dsh-rpc/health",
      status: "/dsh-rpc/status",
    });

    // The page must never become a side channel: no token, no session handle,
    // no prompt body.
    assert.ok(!res.body.includes(TOKEN), "the bearer token must not be echoed");
    assert.ok(!res.body.includes("session-secret"), "session ids stay out of the payload");
    // `state` is what makes a queued run distinguishable from a stuck one.
    assert.deepEqual(body.activeRuns, [
      { run: "abcdef12", prompt: true, ageMs: 1200, hasSession: true, state: "running" },
    ]);
    assert.deepEqual(body.calls, {
      total: 0,
      errors: 0,
      lastCallAt: null,
      lastErrorAt: null,
      byMethod: {},
      recent: [],
    });
  } finally {
    routes.dispose();
  }
});

test("stats count what the bridge served, without recording arguments", async () => {
  const stats = createStats({ startedAt: Date.now(), pid: 1 });
  stats.record("dsh.sessions.ask", 12, true);
  stats.record("ask", 30, false, -32004);

  const snapshot = stats.snapshot();
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.errors, 1);
  assert.deepEqual(Object.keys(snapshot.byMethod).sort(), ["ask", "dsh.sessions.ask"]);
  assert.equal(snapshot.byMethod["dsh.sessions.ask"].count, 1);
  assert.equal(snapshot.byMethod.ask.errors, 1);
  assert.equal(snapshot.recent.length, 2);
  // Only these five fields — a record must never grow a `params` field.
  for (const entry of snapshot.recent) {
    assert.deepEqual(Object.keys(entry).sort(), ["at", "code", "method", "ms", "ok"]);
  }
  assert.equal(snapshot.lastCallAt, snapshot.recent[0].at);
  assert.equal(snapshot.lastErrorAt, snapshot.recent[0].at);
});

test("a remote address is refused", async () => {
  const { server, routes } = harness();
  try {
    const res = fakeRes();
    await server.routes.get("/dsh-rpc/status")(fakeReq({ address: "10.0.0.7" }), res);
    assert.equal(res.status, 403);
    assert.equal(res.json().error, "loopback only");
  } finally {
    routes.dispose();
  }
});

test("only GET and HEAD are accepted", async () => {
  const { server, routes } = harness();
  try {
    const res = fakeRes();
    await server.routes.get("/dsh-rpc/status")(fakeReq({ method: "POST" }), res);
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, "GET");
  } finally {
    routes.dispose();
  }
});

test("a second generation takes over the same routes instead of colliding", async () => {
  const server = fakeServer();
  const first = harness({ server });
  assert.equal(server.routes.size, 4);

  // A reload re-imports the module and reruns apply against the same host
  // server. Without the shared route cells this second call would throw
  // "duplicate exact route", which is exactly how a reload used to wedge.
  const second = harness({ server });
  assert.equal(server.routes.size, 4, "re-adoption must not add routes");

  const res = fakeRes();
  await server.routes.get("/dsh-rpc/status")(fakeReq(), res);
  assert.equal(res.status, 200, "the newest generation answers");

  // The newest owner is the one allowed to unmount, and disposing the older
  // generation must not pull the route out from under it.
  first.routes.dispose();
  assert.equal(server.routes.size, 4, "the previous owner's disposer is a no-op");

  second.routes.dispose();
  assert.equal(server.routes.size, 0, "the current owner really unmounts");

  // And the path is usable again afterwards.
  const third = harness({ server });
  assert.equal(server.routes.size, 4);
  third.routes.dispose();
});

test("a mount that fails midway leaves nothing behind", () => {
  const server = fakeServer();
  const register = server.register.bind(server);
  let calls = 0;
  server.register = (route) => {
    calls += 1;
    if (calls === 3) throw new Error('webserver: duplicate exact route "/dsh-rpc/health"');
    return register(route);
  };

  assert.throws(() => harness({ server }), /duplicate exact route/);
  assert.equal(server.routes.size, 0, "the two routes mounted before the failure are rolled back");

  // The rollback also released the cells, so a later attempt can mount cleanly.
  server.register = register;
  const retry = harness({ server });
  assert.equal(server.routes.size, 4);
  retry.routes.dispose();
  assert.equal(server.routes.size, 0);
});
