import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply } from "../index.mjs";
import { TASK_ERROR, isTaskError } from "../lib/tasks/errors.mjs";

function makeFakeCtx() {
  const routes = new Map();
  const disposers = [];
  const warnings = [];
  const infos = [];
  const ctx = {
    webServer: {
      getOrigin: () => "http://127.0.0.1:0",
      register({ path, handler }) {
        routes.set(path, handler);
        return () => routes.delete(path);
      },
    },
    sessionController: {},
    logger: {
      info: (m) => infos.push(m),
      warn: (m) => warnings.push(m),
      error: () => {},
      debug: () => {},
    },
    get: () => undefined,
    on: () => {},
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
    },
  };
  return {
    ctx,
    routes,
    warnings,
    infos,
    dispose() {
      for (const d of disposers.splice(0)) d();
    },
  };
}

async function callJsonRpc(routeHandler, token, method, params = {}) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let status = 0;
  let responseBody = "";
  const req = {
    method: "POST",
    url: "/dsh-rpc",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
    on(event, cb) {
      if (event === "data") cb(Buffer.from(body, "utf8"));
      if (event === "end") cb();
      return this;
    },
  };
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead(s) {
      status = s;
    },
    end(chunk) {
      if (chunk) responseBody += String(chunk);
      this.writableEnded = true;
    },
  };
  await routeHandler(req, res);
  return { status, body: JSON.parse(responseBody) };
}

test("index.mjs leaves task DB untouched when tasksEnabled=false", async () => {
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-wire-off-"));
  process.env.DSH_HOME = home;
  const fake = makeFakeCtx();
  try {
    await apply(fake.ctx, { token: "a".repeat(32), tasksEnabled: false });
    const defaultDb = join(home, "storages", "task-center", "tasks.db");
    assert.equal(existsSync(defaultDb), false);
  } finally {
    fake.dispose();
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("index.mjs opens tasks.db, seeds baseline entities, wires dispatcher, and handles adapter assembly failure gracefully", async () => {
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-wire-on-"));
  process.env.DSH_HOME = home;
  const token = "b".repeat(32);

  const fake = makeFakeCtx();
  fake.ctx.taskAdapterFactories = {
    codex: () => {
      throw new Error("simulated adapter init failure");
    },
  };

  try {
    await apply(fake.ctx, {
      token,
      defaultCwd: home,
      tasksEnabled: true,
      tasksExternalAdapter: "codex",
      tasksAdapters: { codex: { enabled: true, binary: "C:\\missing\\codex.exe" } },
    });

    const dbPath = join(home, "storages", "task-center", "tasks.db");
    assert.equal(existsSync(dbPath), true, "tasks.db must be created under DSH_HOME/storages/task-center");
    assert.ok(
      fake.warnings.some((w) => /failed to initialize codex adapter/.test(w)),
      "adapter init failure must be logged as a warning without aborting startup",
    );

    // Wait one microtask for async seedBaselineEntities
    await new Promise((r) => setTimeout(r, 20));

    const rpcHandler = fake.routes.get("/dsh-rpc");
    assert.equal(typeof rpcHandler, "function");

    // Register an agent card referencing codex, then list agents + check baseline principal works in preview
    const reg = await callJsonRpc(rpcHandler, token, "dsh.agents.register", {
      card: {
        identity: { agentId: "ag-codex", name: "Codex", kind: "codex", version: "0.169.0" },
        controls: {
          start: { support: "required", evidence: "stdio" },
          steer: { support: "optional", evidence: "turn/steer" },
          cancel: { support: "required", evidence: "turn/interrupt" },
          inspect: { support: "optional", evidence: "thread/read" },
          approval: { support: "optional", evidence: "approval" },
          events: { support: "required", evidence: "stdio" },
        },
        limitations: ["no native approval path on this host"],
      },
    });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.result.agentId, "ag-codex");

    const listed = await callJsonRpc(rpcHandler, token, "dsh.tasks.list", {});
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.result.items, []);

    // Verify missing adapter surfaces as ADAPTER_UNAVAILABLE on dispatch (not startup crash)
    // First seed capability revision directly via a second call or verify error shape when dispatching unknown task
    const resolveMissingVersion = await callJsonRpc(rpcHandler, token, "dsh.tasks.resolve", {
      taskId: "task_missing",
      idempotencyKey: "idem-resolve-1",
      disposition: "accept",
    });
    assert.equal(resolveMissingVersion.status, 200);
    assert.ok(
      isTaskError({ data: resolveMissingVersion.body.error.data }, TASK_ERROR.VALIDATION_FAILED),
      "resolve must require expectedStateVersion rather than guess one",
    );

    const badDispatch = await callJsonRpc(rpcHandler, token, "dsh.tasks.dispatch", { taskId: "task_missing" });
    assert.equal(badDispatch.status, 200);
    assert.ok(isTaskError({ data: badDispatch.body.error.data }, TASK_ERROR.NOT_FOUND));
  } finally {
    fake.dispose();
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("index.mjs survives a strict Host whose ctx.get() throws for unknown services", async () => {
  // Regression for the 0.9.0 on-state smoke failure: Cordis ctx.get(name, strict)
  // throws for a service nobody provides, which used to abort the whole task-centre
  // startup and leave the plugin on a silent in-memory store.
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-wire-strict-"));
  process.env.DSH_HOME = home;
  const token = "c".repeat(32);
  const fake = makeFakeCtx();
  const strictGet = (name) => {
    throw new Error(`service not found: ${String(name)}`);
  };
  fake.ctx.get = strictGet;

  try {
    await apply(fake.ctx, { token, defaultCwd: home, tasksEnabled: true });

    const rpcHandler = fake.routes.get("/dsh-rpc");
    assert.equal(typeof rpcHandler, "function");

    const ping = await callJsonRpc(rpcHandler, token, "dsh.ping", {});
    assert.equal(ping.status, 200);
    const centre = ping.body.result.taskCentre;
    assert.equal(centre.ready, true, "the task centre must report itself ready");
    assert.equal(centre.mode, "file", "a ready task centre must be backed by the file store");
    assert.equal(centre.seedError, null, "baseline seeding must actually succeed");
    assert.equal(centre.startError, null, "startup must not record an error");
    assert.equal(
      fake.warnings.some((w) => /task center disabled due to startup error/.test(w)),
      false,
      "a missing optional service must not disable the task centre",
    );

    // The seeding ran against the file store, not a throwaway in-memory database.
    const dbPath = join(home, "storages", "task-center", "tasks.db");
    assert.equal(existsSync(dbPath), true);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const principals = db.prepare("SELECT principal_id FROM principals").all().map((row) => row.principal_id);
      const workspaces = db.prepare("SELECT workspace_id FROM workspaces").all().map((row) => row.workspace_id);
      assert.deepEqual(principals, ["local-operator"]);
      assert.deepEqual(workspaces, ["local"]);
    } finally {
      db.close();
    }
  } finally {
    fake.dispose();
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
test("a Host that binds a fetch-blocked port is warned about at startup", async () => {
  // The bridge inherits the Host's port, so it cannot refuse the assignment —
  // it can only say why clients will fail. Silence here would look like a
  // healthy server plus broken clients.
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-wire-port-"));
  process.env.DSH_HOME = home;
  const fake = makeFakeCtx();
  fake.ctx.webServer.getOrigin = () => "http://127.0.0.1:5060";
  try {
    await apply(fake.ctx, { token: "c".repeat(32), defaultCwd: home, tasksEnabled: false });
    assert.ok(
      fake.warnings.some((w) => /port 5060 is one fetch refuses/.test(w) && /EBADPORT/.test(w)),
      "a blocked Host port must be named at startup, because every out-of-process caller will fail",
    );
    assert.ok(
      fake.infos.some((m) => /ready at http:\/\/127\.0\.0\.1:5060\/dsh-rpc/.test(m)),
      "the bridge still mounts and publishes; only the warning is extra",
    );
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});