import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, describeConfig, resolveConfig } from "../lib/config.mjs";
import { buildDispatcher } from "../lib/http.mjs";
import { createMethods } from "../lib/methods.mjs";
import { TASK_ERROR, isTaskError } from "../lib/tasks/errors.mjs";
import { createTaskEngine, seedBaselineEntities } from "../lib/tasks/engine.mjs";
import { reconcileTask } from "../lib/tasks/reconcile.mjs";
import { transition } from "../lib/tasks/state-machine.mjs";
import { openStore } from "../lib/tasks/store.mjs";

async function setup() {
  const store = openStore({ path: ":memory:" });
  await seedBaselineEntities(store, {
    principal: { principalId: "local-operator" },
    workspace: { workspaceId: "ws-1", rootPath: "C:\\ws-1" },
    agent: { agentId: "ag-no-cancel", adapterKind: "legacy", capabilities: { cancel: "unsupported" } },
    capabilityRevision: { revisionId: "cap-1", capability: "review.diff@1" },
  });
  await seedBaselineEntities(store, {
    agent: { agentId: "ag-cancel", adapterKind: "antigravity", capabilities: { cancel: "supported" } },
  });
  return { store, engine: createTaskEngine(store) };
}

test("reconcileTask closes stale active attempt on needs_reconcile -> cancelled and writes reconcile.applied event", async () => {
  const { store, engine } = await setup();
  try {
    const t = await engine.submit({
      idempotencyKey: "rec-1",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-no-cancel",
    });
    const att = await engine.recordAttemptStart({ taskId: t.taskId, expectedStateVersion: t.stateVersion });

    // Cancel on unsupported executor moves task to needs_reconcile while attempt stays side_effect_active=1
    const c = await engine.cancel({
      taskId: t.taskId,
      expectedStateVersion: att.stateVersion,
      idempotencyKey: "c-rec-1",
    });
    assert.equal(c.status, "needs_reconcile");

    // Requeue before closing active attempt is blocked by STATE_CONFLICT
    await assert.rejects(
      () =>
        engine.resolve({
          taskId: t.taskId,
          expectedStateVersion: c.stateVersion,
          idempotencyKey: "req-blocked",
          disposition: "requeue",
        }),
      (err) => isTaskError(err, TASK_ERROR.STATE_CONFLICT),
    );

    const reconciled = await reconcileTask(engine, store, {
      taskId: t.taskId,
      evidence: {
        observedState: "cancelled",
        note: "verified child process exited",
        adapterEventId: "obs-1",
      },
    });

    assert.equal(reconciled.from, "needs_reconcile");
    assert.equal(reconciled.status, "cancelled");
    assert.equal(reconciled.stateVersion, c.stateVersion + 1);
    assert.equal(reconciled.attemptsClosed, 1);
    assert.equal(reconciled.event.type, "reconcile.applied");

    const attemptRow = store.read((db) =>
      db.prepare("SELECT status, side_effect_active FROM attempts WHERE attempt_id = ?").get(att.attemptId),
    );
    assert.equal(attemptRow.side_effect_active, 0);
    assert.equal(attemptRow.status, "cancelled");

    const evts = await engine.events({ taskId: t.taskId, afterSeq: 0 });
    const recEvt = evts.events.find((e) => e.type === "reconcile.applied");
    assert.ok(recEvt, "reconcile.applied event must be recorded");
    assert.equal(recEvt.evidence.observedState, "cancelled");
    assert.equal(recEvt.evidence.note, "verified child process exited");
  } finally {
    store.close();
  }
});

test("clearing side_effect_active on a needs_reconcile task unblocks resolve(requeue), and reconcileTask works on cancel_requested", async () => {
  const { store, engine } = await setup();
  try {
    // Part A: resolve(requeue) succeeds once side_effect_active is 0
    const t1 = await engine.submit({
      idempotencyKey: "req-unblock-1",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-cancel",
    });
    const att1 = await engine.recordAttemptStart({ taskId: t1.taskId, expectedStateVersion: t1.stateVersion });
    const nr1 = await transition(store, {
      taskId: t1.taskId,
      expectedStateVersion: att1.stateVersion,
      to: "needs_reconcile",
      reason: "dispatch receipt missing",
    });
    await store.withWriteTx((db) => {
      db.prepare("UPDATE attempts SET side_effect_active = 0, status = 'aborted' WHERE attempt_id = ?").run(
        att1.attemptId,
      );
    });
    const requeued = await engine.resolve({
      taskId: t1.taskId,
      expectedStateVersion: nr1.stateVersion,
      idempotencyKey: "req-ok-1",
      disposition: "requeue",
    });
    assert.equal(requeued.status, "queued");

    // Part B: cancel_requested reconciles to succeeded with result
    const t2 = await engine.submit({
      idempotencyKey: "rec-cancel-req",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-cancel",
    });
    const att2 = await engine.recordAttemptStart({ taskId: t2.taskId, expectedStateVersion: t2.stateVersion });
    const c2 = await engine.cancel({
      taskId: t2.taskId,
      expectedStateVersion: att2.stateVersion,
      idempotencyKey: "c-rec-2",
    });
    assert.equal(c2.status, "cancel_requested");

    const rec2 = await reconcileTask(engine, store, {
      taskId: t2.taskId,
      evidence: { observedState: "succeeded", result: { summary: "finished before cancel" } },
    });
    assert.equal(rec2.status, "succeeded");
    assert.equal(rec2.attemptsClosed, 1);

    const detail2 = await engine.get({ taskId: t2.taskId });
    assert.deepEqual(detail2.result, { summary: "finished before cancel" });
  } finally {
    store.close();
  }
});

test("reconcileTask rejects tasks outside needs_reconcile / cancel_requested with STATE_CONFLICT", async () => {
  const { store, engine } = await setup();
  try {
    const t = await engine.submit({
      idempotencyKey: "rec-wrong-state",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-cancel",
    });

    await assert.rejects(
      () =>
        reconcileTask(engine, store, {
          taskId: t.taskId,
          evidence: { observedState: "cancelled" },
        }),
      (err) => isTaskError(err, TASK_ERROR.STATE_CONFLICT),
    );
  } finally {
    store.close();
  }
});

test("RPC wiring covers dsh.agents.{register,list,probe}, dsh.tasks.{preview,reconcile}, and W2 config bounds", async () => {
  // Enabled, because a disabled task centre deliberately hides its methods;
  // the bounds assertions below are independent of the breaker.
  const cfg = resolveConfig({ tasksEnabled: true });
  assert.equal(describeConfig(cfg).tasksDbPath, null);
  assert.equal(describeConfig(cfg).tasksProbeTimeoutMs, 5_000);
  assert.equal(describeConfig(cfg).tasksPreviewTtlMs, 300_000);
  assert.throws(() => resolveConfig({ tasksProbeTimeoutMs: 50 }), ConfigError);
  assert.throws(() => resolveConfig({ tasksPreviewTtlMs: 999 }), ConfigError);

  const store = openStore({ path: ":memory:" });
  try {
    await seedBaselineEntities(store, {
      principal: { principalId: "local-operator" },
      workspace: { workspaceId: "ws-lab", rootPath: "C:\\ws-lab" },
      capabilityRevision: { revisionId: "cap-review-1", capability: "review.diff@1" },
    });
    const engine = createTaskEngine(store);
    const methods = createMethods(
      {
        sessionController: {},
        webServer: { getOrigin: () => "http://127.0.0.1:0" },
        taskStore: store,
        taskEngine: engine,
        agentProbes: {
          "ag-codex": {
            start: async () => true,
            cancel: async () => true,
            inspect: async () => true,
            events: async () => true,
          },
        },
      },
      cfg,
      { get: () => undefined },
      {},
    );
    const dispatch = buildDispatcher(methods);

    const reg = await dispatch("dsh.agents.register", {
      card: {
        identity: { agentId: "ag-codex", name: "Codex", kind: "codex", version: "0.169.0" },
        controls: {
          start: { support: "required", evidence: "thread/start" },
          steer: { support: "optional", evidence: "turn/steer" },
          cancel: { support: "required", evidence: "turn/interrupt" },
          inspect: { support: "optional", evidence: "thread/read" },
          approval: { support: "optional", evidence: "approval" },
          events: { support: "required", evidence: "stdio" },
        },
        limitations: ["local windows only"],
      },
    });
    assert.equal(reg.probeStatus, "unverified");
    assert.equal(reg.card.verified, false);

    const probed = await dispatch("dsh.agents.probe", {
      agentId: "ag-codex",
      evidence: ["phase0:codex-stdio"],
    });
    // Four of six controls answered; that is partial evidence, not verification.
    assert.equal(probed.probeStatus, "partial");
    assert.equal(probed.card.verified, false);
    assert.equal(probed.card.partial, true);
    assert.deepEqual(probed.verifiedControls, ["start", "cancel", "inspect", "events"]);
    assert.deepEqual(probed.verified, { start: true, cancel: true, inspect: true, events: true });
    assert.deepEqual(probed.card.unknown, ["steer", "approval"]);

    const listed = await dispatch("dsh.agents.list", { verifiedOnly: true });
    assert.equal(listed.total, 0, "a partially probed agent must not pass verifiedOnly");
    const all = await dispatch("dsh.agents.list", {});
    assert.equal(all.total, 1);
    assert.equal(all.items[0].agentId, "ag-codex");
    assert.equal(all.items[0].probeStatus, "partial");

    const pv = await dispatch("dsh.tasks.preview", {
      principalId: "local-operator",
      capabilityRevisionId: "cap-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-codex",
      input: { diff: "abc" },
    });
    const sub = await dispatch("dsh.tasks.submit", {
      previewId: pv.previewId,
      idempotencyKey: "w2-e2e-1",
    });
    const att = await engine.recordAttemptStart({ taskId: sub.taskId, expectedStateVersion: sub.stateVersion });
    const can = await dispatch("dsh.tasks.cancel", {
      taskId: sub.taskId,
      expectedStateVersion: att.stateVersion,
      idempotencyKey: "w2-cancel-1",
    });
    assert.equal(can.status, "cancel_requested");

    const rec = await dispatch("dsh.tasks.reconcile", {
      taskId: sub.taskId,
      evidence: { observedState: "cancelled", note: "turn/completed interrupted" },
    });
    assert.equal(rec.status, "cancelled");
    assert.equal(rec.attemptsClosed, 1);
  } finally {
    store.close();
  }
});
