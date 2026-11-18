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

test("RPC wiring exposes dsh.tasks.dispatch/pump and config validates tasksAdapters and tasksDispatchMaxSteps", async () => {
  const cfg = resolveConfig({
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
