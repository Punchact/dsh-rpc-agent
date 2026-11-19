import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, describeConfig, resolveConfig } from "../lib/config.mjs";
import { buildDispatcher as buildRpcDispatcher } from "../lib/http.mjs";
import { createMethods } from "../lib/methods.mjs";
import { createDispatcher } from "../lib/tasks/dispatch.mjs";
import { createTaskEngine, seedBaselineEntities } from "../lib/tasks/engine.mjs";
import { openStore } from "../lib/tasks/store.mjs";

function makeFakeAdapter(overrides = {}) {
  const calls = { start: 0, inspect: 0, cancel: 0, events: 0, decideApproval: 0 };
  const adapter = {
    calls,
    async probe() {
      return { ok: true };
    },
    async start(ctx) {
      calls.start += 1;
      if (overrides.onStart) return overrides.onStart(ctx);
      return { accepted: true, locator: { kind: "fake", remoteId: "rem-1" } };
    },
    async inspect(ctx) {
      calls.inspect += 1;
      if (overrides.onInspect) return overrides.onInspect(ctx);
      return { state: "progress", message: "working" };
    },
    async sendInput() {
      return { accepted: true };
    },
    async cancel(ctx) {
      calls.cancel += 1;
      if (overrides.onCancel) return overrides.onCancel(ctx);
      return { requestAccepted: true };
    },
    async events(ctx, locator, cursor) {
      calls.events += 1;
      if (overrides.onEvents) return overrides.onEvents(ctx, locator, cursor);
      return { events: [], nextCursor: cursor ?? 0 };
    },
    async decideApproval() {
      calls.decideApproval += 1;
      return { accepted: true };
    },
  };
  return adapter;
}

async function setupWithAdapter(adapter) {
  const store = openStore({ path: ":memory:" });
  await seedBaselineEntities(store, {
    principal: { principalId: "local-operator" },
    workspace: { workspaceId: "ws-1", rootPath: "C:\\ws-1" },
    agent: { agentId: "ag-1", adapterKind: "fake", capabilities: { cancel: "supported" } },
    capabilityRevision: { revisionId: "cap-1", capability: "review.diff@1" },
  });
  const engine = createTaskEngine(store);
  const dispatcher = createDispatcher({ store, engine, adapters: { fake: adapter } });
  return { store, engine, dispatcher };
}

test("startTask transitions queued -> dispatching -> running, and adapter throw transitions to needs_reconcile with dispatch.failed", async () => {
  // Success path
  const okAdapter = makeFakeAdapter();
  const s1 = await setupWithAdapter(okAdapter);
  try {
    const t = await s1.engine.submit({
      idempotencyKey: "disp-ok-1",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    const res = await s1.dispatcher.startTask({ taskId: t.taskId });
    assert.equal(res.status, "running");
    assert.equal(res.dispatchFailed, false);
    assert.deepEqual(res.locator, { kind: "fake", remoteId: "rem-1" });
    assert.equal(okAdapter.calls.start, 1);
  } finally {
    s1.store.close();
  }

  // Throw path -> needs_reconcile, never stuck in dispatching
  const failAdapter = makeFakeAdapter({
    onStart() {
      throw new Error("daemon unreachable");
    },
  });
  const s2 = await setupWithAdapter(failAdapter);
  try {
    const t = await s2.engine.submit({
      idempotencyKey: "disp-fail-1",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    const res = await s2.dispatcher.startTask({ taskId: t.taskId });
    assert.equal(res.status, "needs_reconcile");
    assert.equal(res.dispatchFailed, true);

    const evts = await s2.engine.events({ taskId: t.taskId, afterSeq: 0 });
    assert.ok(evts.events.some((e) => e.type === "dispatch.failed"));
  } finally {
    s2.store.close();
  }
});

test("pump forwards reports through engine, moves unknown/blocked to needs_reconcile, and respects maxSteps", async () => {
  let stepCount = 0;
  const adapter = makeFakeAdapter({
    onEvents(_ctx, _loc, cursor) {
      stepCount += 1;
      if (stepCount <= 3) {
        return {
          events: [{ adapterEventId: `ev-${stepCount}`, report: { state: "progress", message: `step ${stepCount}` } }],
          nextCursor: (cursor ?? 0) + 1,
        };
      }
      return {
        events: [{ adapterEventId: "ev-4", report: { state: "ready", result: { ok: true }, resultValid: true } }],
        nextCursor: (cursor ?? 0) + 1,
      };
    },
  });

  const { store, engine, dispatcher } = await setupWithAdapter(adapter);
  try {
    const t = await engine.submit({
      idempotencyKey: "pump-1",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    await dispatcher.startTask({ taskId: t.taskId });

    // Bounded to maxSteps=2 stops at 2 and reports hitMaxSteps=true
    const p1 = await dispatcher.pump({ taskId: t.taskId, maxSteps: 2 });
    assert.equal(p1.stepsProcessed, 2);
    assert.equal(p1.hitMaxSteps, true);
    assert.equal(p1.status, "running");

    // Drain remaining events to reach review_pending
    const p2 = await dispatcher.pump({ taskId: t.taskId, maxSteps: 10, cursor: p1.nextCursor });
    assert.equal(p2.status, "review_pending");
    assert.equal(p2.hitMaxSteps, false);
  } finally {
    store.close();
  }

  // Plain blocked/unknown inspect moves task to needs_reconcile
  const blockedAdapter = makeFakeAdapter({
    onInspect: () => ({ state: "blocked", reason: "unrecognized status" }),
  });
  const sBlocked = await setupWithAdapter(blockedAdapter);
  try {
    const t = await sBlocked.engine.submit({
      idempotencyKey: "pump-blocked",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    await sBlocked.dispatcher.startTask({ taskId: t.taskId });
    const p = await sBlocked.dispatcher.pump({ taskId: t.taskId });
    assert.equal(p.status, "needs_reconcile");
    const evts = await sBlocked.engine.events({ taskId: t.taskId, afterSeq: 0 });
    assert.ok(evts.events.some((e) => e.type === "inspect.unknown"));
  } finally {
    sBlocked.store.close();
  }
});

test("drainEffects executes cancel effect exactly once and ignores replay", async () => {
  const adapter = makeFakeAdapter();
  const { store, engine, dispatcher } = await setupWithAdapter(adapter);
  try {
    const t = await engine.submit({
      idempotencyKey: "drain-1",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    const started = await dispatcher.startTask({ taskId: t.taskId });
    await engine.cancel({
      taskId: t.taskId,
      expectedStateVersion: started.stateVersion,
      idempotencyKey: "cancel-drain-1",
    });

    const d1 = await dispatcher.drainEffects({ limit: 10 });
    assert.equal(d1.processed, 1);
    assert.equal(d1.completed, 1);
    assert.equal(adapter.calls.cancel, 1);

    // Replay does not fire adapter.cancel a second time
    const d2 = await dispatcher.drainEffects({ limit: 10 });
    assert.equal(d2.processed, 0);
    assert.equal(adapter.calls.cancel, 1);
  } finally {
    store.close();
  }
});

test("drainEffects reclaims an in-flight effect whose lease expired", async () => {
  const adapter = makeFakeAdapter();
  const { store, engine, dispatcher } = await setupWithAdapter(adapter);
  try {
    const t = await engine.submit({
      idempotencyKey: "lease-1",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    const started = await dispatcher.startTask({ taskId: t.taskId });
    await engine.cancel({
      taskId: t.taskId,
      expectedStateVersion: started.stateVersion,
      idempotencyKey: "cancel-lease-1",
    });

    // Simulate a drain that died after claiming: in_flight with an expired lease.
    const expired = new Date(Date.now() - 60_000).toISOString();
    store.withWriteTx((db) => {
      db.prepare(
        "UPDATE effects SET status = 'in_flight', lease_expires_at = ?, updated_at = ? WHERE task_id = ?",
      ).run(expired, expired, t.taskId);
    });

    const d = await dispatcher.drainEffects({ limit: 10 });
    assert.equal(d.processed, 1);
    assert.equal(d.completed, 1);
    assert.equal(adapter.calls.cancel, 1);
  } finally {
    store.close();
  }
});

test("a cancel the runtime refuses becomes needs_reconcile instead of a silent hang", async () => {
  const adapter = makeFakeAdapter({
    onCancel() {
      throw new Error("runtime refused to stop");
    },
  });
  const { store, engine, dispatcher } = await setupWithAdapter(adapter);
  try {
    const t = await engine.submit({
      idempotencyKey: "cancel-fail-1",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    const started = await dispatcher.startTask({ taskId: t.taskId });
    await engine.cancel({
      taskId: t.taskId,
      expectedStateVersion: started.stateVersion,
      idempotencyKey: "cancel-fail-1-cancel",
    });

    const d = await dispatcher.drainEffects({ limit: 10 });
    assert.equal(d.failed, 1);

    const got = await engine.get({ taskId: t.taskId });
    assert.equal(got.status, "needs_reconcile");
    const evts = await engine.events({ taskId: t.taskId, afterSeq: 0 });
    assert.ok(evts.events.some((e) => e.type === "cancel.failed"));
  } finally {
    store.close();
  }
});

test("startTask keeps the runtime locator when the ledger refuses the attempt", async () => {
  const adapter = makeFakeAdapter();
  const { store, engine, dispatcher } = await setupWithAdapter(adapter);
  try {
    const t = await engine.submit({
      idempotencyKey: "orphan-1",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    // A cancel lands while the adapter is starting: the attempt can no longer be
    // recorded, but the run exists and its locator must survive.
    adapter.start = async () => {
      const row = store.read((db) => db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(t.taskId));
      await engine.cancel({
        taskId: t.taskId,
        expectedStateVersion: row.state_version,
        idempotencyKey: "orphan-1-cancel",
        reason: "cancelled mid-dispatch",
      });
      return { accepted: true, locator: { kind: "fake", remoteId: "rem-orphan" } };
    };

    const res = await dispatcher.startTask({ taskId: t.taskId });
    assert.equal(res.orphan, true);
    assert.deepEqual(res.locator, { kind: "fake", remoteId: "rem-orphan" });
    assert.equal(res.status, "needs_reconcile");

    const evts = await engine.events({ taskId: t.taskId, afterSeq: 0 });
    const orphan = evts.events.find((e) => e.type === "dispatch.orphaned");
    assert.ok(orphan);
    assert.deepEqual(orphan.evidence?.runtimeLocator, { kind: "fake", remoteId: "rem-orphan" });
  } finally {
    store.close();
  }
});

test("RPC wiring exposes dsh.tasks.dispatch/pump and config validates tasksAdapters and tasksDispatchMaxSteps", async () => {
  const cfg = resolveConfig({
    tasksEnabled: true,
    tasksAdapters: { antigravity: { enabled: true, projectId: "p1" } },
    tasksDispatchMaxSteps: 25,
  });
  assert.equal(describeConfig(cfg).tasksDispatchMaxSteps, 25);
  assert.deepEqual(describeConfig(cfg).tasksAdapters, { antigravity: { enabled: true, projectId: "p1" } });
  assert.throws(() => resolveConfig({ tasksDispatchMaxSteps: 0 }), ConfigError);
  assert.throws(() => resolveConfig({ tasksAdapters: { bad: { enabled: "yes" } } }), ConfigError);

  const adapter = makeFakeAdapter({
    onInspect: () => ({ state: "ready", result: { done: true }, resultValid: true }),
  });
  const { store, engine } = await setupWithAdapter(adapter);
  try {
    const methods = createMethods(
      {
        sessionController: {},
        webServer: { getOrigin: () => "http://127.0.0.1:0" },
        taskStore: store,
        taskEngine: engine,
        adapters: { fake: adapter },
      },
      cfg,
      { get: () => undefined },
      {},
    );
    const rpc = buildRpcDispatcher(methods);
    const sub = await rpc("dsh.tasks.submit", {
      idempotencyKey: "rpc-disp-1",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    const disp = await rpc("dsh.tasks.dispatch", { taskId: sub.taskId });
    assert.equal(disp.status, "running");

    const pumped = await rpc("dsh.tasks.pump", { taskId: sub.taskId });
    assert.equal(pumped.status, "review_pending");
  } finally {
    store.close();
  }
});

test("startTask enforces the maxConcurrent gate without leaving tasks in dispatching", async () => {
  const adapter = makeFakeAdapter();
  const s1 = await setupWithAdapter(adapter);
  try {
    const capped = createDispatcher({
      store: s1.store,
      engine: s1.engine,
      adapters: { fake: adapter },
      maxConcurrent: 1,
    });
    const t1 = await s1.engine.submit({
      idempotencyKey: "gate-1",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    const t2 = await s1.engine.submit({
      idempotencyKey: "gate-2",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });

    await capped.startTask({ taskId: t1.taskId });
    await assert.rejects(
      () => capped.startTask({ taskId: t2.taskId }),
      (err) => err?.data?.reason === "max_concurrent" && err?.data?.maxConcurrent === 1,
    );

    const t2Detail = await s1.engine.get({ taskId: t2.taskId });
    assert.equal(t2Detail.status, "queued");
    assert.equal(t2Detail.stateVersion, 1);
    assert.equal(adapter.calls.start, 1);

    const wider = createDispatcher({
      store: s1.store,
      engine: s1.engine,
      adapters: { fake: adapter },
      maxConcurrent: 2,
    });
    const started2 = await wider.startTask({ taskId: t2.taskId });
    assert.equal(started2.status, "running");
    assert.equal(adapter.calls.start, 2);
  } finally {
    s1.store.close();
  }
});

test("dispatch, pump, and drainEffects sanitize raw adapter exceptions out of ledger/results while logging to debug", async () => {
  const secretRaw = "connect ECONNREFUSED http://127.0.0.1:4035 token=csrf_top_secret_99 C:\\Users\\Andy\\priv.key";
  const debugLogs = [];
  const logger = { debug: (msg, meta) => debugLogs.push({ msg, meta }) };

  const failStartAdapter = makeFakeAdapter({
    onStart() {
      const err = new Error(secretRaw);
      err.code = "ECONNREFUSED";
      throw err;
    },
  });
  const s1 = await setupWithAdapter(failStartAdapter);
  try {
    const disp = createDispatcher({
      store: s1.store,
      engine: s1.engine,
      adapters: { fake: failStartAdapter },
      logger,
    });
    const t = await s1.engine.submit({
      idempotencyKey: "sec2-start",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    const res = await disp.startTask({ taskId: t.taskId });
    assert.equal(res.dispatchFailed, true);
    assert.equal(res.error, "the execution backend is unavailable");
    assert.doesNotMatch(JSON.stringify(res), /127\.0\.0\.1:4035|csrf_top_secret_99|priv\.key|ECONNREFUSED/);

    const detail = await s1.engine.get({ taskId: t.taskId });
    const evts = await s1.engine.events({ taskId: t.taskId, afterSeq: 0 });
    assert.doesNotMatch(JSON.stringify(detail), /127\.0\.0\.1:4035|csrf_top_secret_99|priv\.key/);
    assert.doesNotMatch(JSON.stringify(evts), /127\.0\.0\.1:4035|csrf_top_secret_99|priv\.key/);
    assert.ok(debugLogs.length >= 1);
    assert.doesNotMatch(JSON.stringify(debugLogs), /csrf_top_secret_99/);
  } finally {
    s1.store.close();
  }

  const failPumpCancelAdapter = makeFakeAdapter({
    onEvents() {
      throw new Error(secretRaw);
    },
    onCancel() {
      throw new Error(secretRaw);
    },
  });
  const s2 = await setupWithAdapter(failPumpCancelAdapter);
  try {
    const disp = createDispatcher({
      store: s2.store,
      engine: s2.engine,
      adapters: { fake: failPumpCancelAdapter },
      logger,
    });
    const t = await s2.engine.submit({
      idempotencyKey: "sec2-pump-cancel",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    const started = await disp.startTask({ taskId: t.taskId });
    await assert.rejects(
      () => disp.pump({ taskId: t.taskId }),
      (err) => !err.message.includes("127.0.0.1:4035") && !err.message.includes("csrf_top_secret_99"),
    );

    await s2.engine.cancel({
      taskId: t.taskId,
      expectedStateVersion: started.stateVersion,
      idempotencyKey: "sec2-cancel-idem",
    });
    const d = await disp.drainEffects({ limit: 10 });
    assert.equal(d.failed, 1);

    const effRows = s2.store.read((db) => db.prepare("SELECT * FROM effects WHERE task_id = ?").all(t.taskId));
    assert.doesNotMatch(JSON.stringify(effRows), /127\.0\.0\.1:4035|csrf_top_secret_99|priv\.key/);
  } finally {
    s2.store.close();
  }
});

test("dispatch logger omits raw exception text by default, logs redacted [raw] only when enabled, and applyReport redacts ledger text", async () => {
  const secretMsg = "Bearer eyJ_secret_abc sk-1234567890abcdef12 " + "z".repeat(700);
  const makeFailAdapter = () =>
    makeFakeAdapter({
      onStart() {
        const err = new Error(secretMsg);
        err.code = "ECONNREFUSED";
        Object.defineProperty(err, "internalDetail", { value: secretMsg, enumerable: false });
        throw err;
      },
    });

  // 1. Default debugRawAdapterErrors=false: logger receives safe fields only, zero raw message
  const sDefault = await setupWithAdapter(makeFailAdapter());
  const defaultLogs = [];
  try {
    const disp = createDispatcher({
      store: sDefault.store,
      engine: sDefault.engine,
      adapters: { fake: makeFailAdapter() },
      logger: { debug: (msg, meta) => defaultLogs.push({ msg, meta }) },
    });
    const t = await sDefault.engine.submit({
      idempotencyKey: "w7-log-default",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    await disp.startTask({ taskId: t.taskId });
    assert.equal(defaultLogs.length, 1);
    assert.equal(defaultLogs[0].meta.taskId, t.taskId);
    assert.equal(defaultLogs[0].meta.code, "ECONNREFUSED");
    assert.doesNotMatch(JSON.stringify(defaultLogs), /eyJ_secret_abc|sk-1234|\[raw\]|zzz/);
  } finally {
    sDefault.store.close();
  }

  // 2. tasksAdapterDebugDetail config switch + debugRawAdapterErrors=true: logs [raw], redacted, <= 512 chars
  const cfgDefault = resolveConfig({});
  assert.equal(cfgDefault.tasksAdapterDebugDetail, false);
  assert.equal(describeConfig(cfgDefault).tasksAdapterDebugDetail, false);
  const cfgOn = resolveConfig({ tasksAdapterDebugDetail: true });
  assert.equal(cfgOn.tasksAdapterDebugDetail, true);
  assert.throws(() => resolveConfig({ tasksAdapterDebugDetail: "yes" }), ConfigError);

  const sRaw = await setupWithAdapter(makeFailAdapter());
  const rawLogs = [];
  try {
    const disp = createDispatcher({
      store: sRaw.store,
      engine: sRaw.engine,
      adapters: { fake: makeFailAdapter() },
      logger: { debug: (msg, meta) => rawLogs.push({ msg, meta }) },
      debugRawAdapterErrors: true,
    });
    const t = await sRaw.engine.submit({
      idempotencyKey: "w7-log-raw",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    await disp.startTask({ taskId: t.taskId });
    assert.equal(rawLogs.length, 1);
    assert.ok(rawLogs[0].msg.startsWith("[raw] "));
    assert.ok(rawLogs[0].msg.includes("[redacted]"));
    assert.ok(rawLogs[0].msg.includes("… (truncated)"));
    assert.doesNotMatch(rawLogs[0].msg, /eyJ_secret_abc|sk-1234/);
  } finally {
    sRaw.store.close();
  }

  // 3. engine.applyReport redacts report.message, report.summary, and report.attention.prompt/summary before DB insert
  const sEng = await setupWithAdapter(makeFakeAdapter());
  try {
    const t = await sEng.engine.submit({
      idempotencyKey: "w7-engine-redact",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    const startRes = await sEng.dispatcher.startTask({ taskId: t.taskId });
    await sEng.engine.applyReport({
      taskId: t.taskId,
      attemptId: startRes.attemptId,
      adapterEventId: "ev-red-1",
      report: {
        state: "progress",
        message: "step Bearer tok_leak_1",
        summary: "sum ghp_1234567890abcdefghij1234",
      },
    });
    await sEng.engine.applyReport({
      taskId: t.taskId,
      attemptId: startRes.attemptId,
      adapterEventId: "ev-red-2",
      report: {
        state: "waiting",
        attention: {
          kind: "input",
          prompt: "enter key (not sk-1234567890abcdef12)",
          summary: "csrfToken: csrf-secret-xyz",
        },
      },
    });
    const evRows = sEng.store.read((db) => db.prepare("SELECT payload_json FROM events WHERE task_id = ?").all(t.taskId));
    const attRows = sEng.store.read((db) => db.prepare("SELECT prompt FROM attention WHERE task_id = ?").all(t.taskId));
    assert.doesNotMatch(JSON.stringify(evRows), /tok_leak_1|ghp_1234/);
    assert.doesNotMatch(JSON.stringify(attRows), /sk-1234|csrf-secret-xyz/);
    assert.ok(attRows[0].prompt.includes("[redacted]"));
  } finally {
    sEng.store.close();
  }
});
