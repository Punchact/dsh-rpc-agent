// Integration test against the REAL Host WebServer, not a fake.
//
// Everything else in this suite uses a hand-written `webServer` double, which
// cannot catch the failure mode that actually bit this plugin: routes registered
// by a previous activation surviving into the next one, so the reload fails with
// `duplicate exact route` and the row ends up `failed` while the old routes keep
// serving. Only a real server can show that, because only a real server owns the
// route table.
//
// It also pins two contract details learned the hard way: the listener binds
// asynchronously (so `getOrigin()` throws until it does), and the plugin's
// disposer must really remove the routes rather than merely unsubscribe.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The plugin publishes its endpoint + token under $DSH_HOME. Point that at a
// scratch directory so the test never touches the real one.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-rpc-host-"));

const { Context } = await import("@deepseek-ai/cordis");
const { WebServer } = await import("@deepseek-ai/dsh-host-webserver");
const { apply } = await import("../index.mjs");

/** Poll until the service is registered and the listener reports its bound origin. */
async function waitForOrigin(ctx, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const webServer = ctx.webServer;
    if (webServer) {
      try {
        return { webServer, origin: webServer.getOrigin() };
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
    } else if (Date.now() >= deadline) {
      throw new Error("the Host WebServer service never appeared on the context");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function fakeCtx(services) {
  const disposers = [];
  return {
    ...services,
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    on() {
      return () => {};
    },
    get(name) {
      return services[name];
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    disposeEffects() {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

test("the bridge mounts on the real WebServer and unmounts cleanly", { timeout: 30000 }, async () => {
  const ctx = new Context();
  const fork = ctx.plugin(WebServer, { host: "127.0.0.1", port: 0 });
  try {
    const { webServer, origin } = await waitForOrigin(ctx);
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/, "the published origin must be a real bound address");

    const host = fakeCtx({ webServer, sessionController: {} });
    apply(host, {});

    const health = await fetch(`${origin}/dsh-rpc/health`);
    assert.equal(health.status, 200, "health is served without a token");
    assert.equal((await health.json()).ok, true);

    const anonymous = await fetch(`${origin}/dsh-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "dsh.ping" }),
    });
    assert.equal(anonymous.status, 401, "the RPC route must refuse an unauthenticated call");
    assert.match(anonymous.headers.get("www-authenticate") ?? "", /Bearer/);

    const status = await fetch(`${origin}/dsh-rpc/status`);
    assert.equal(status.status, 200);
    const snapshot = await status.json();
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.origin, origin, "the panel must see the same origin the server published");
    assert.equal(typeof snapshot.calls.total, "number");

    const unrouted = await fetch(`${origin}/dsh-rpc/nope`);
    assert.equal(unrouted.status, 404, "an unrouted path inside the prefix is the bridge's 404, not the SPA");

    // The real teardown: the disposer this plugin registered with `ctx.effect`.
    host.disposeEffects();

    for (const path of ["/dsh-rpc/health", "/dsh-rpc/status"]) {
      const gone = await fetch(`${origin}${path}`);
      assert.equal(gone.status, 404, `${path} must stop answering once the plugin is disposed`);
    }
  } finally {
    await fork.dispose();
  }
});
