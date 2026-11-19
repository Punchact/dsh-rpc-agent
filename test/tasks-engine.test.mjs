import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveConfig } from "../lib/config.mjs";
import { buildDispatcher } from "../lib/http.mjs";
import { createMethods } from "../lib/methods.mjs";
import { TASK_ERROR, isTaskError } from "../lib/tasks/errors.mjs";
import { applyReport, createTaskEngine, derivePhase, seedBaselineEntities } from "../lib/tasks/engine.mjs";
import { openStore } from "../lib/tasks/store.mjs";

async function setupEngine(dbPath = ":memory:") {
  const store = openStore({ path: dbPath });
  await seedBaselineEntities(store, {
    principal: { principalId: "local-operator" },
    workspace: { workspaceId: "ws-lab", rootPath: "C:\\ws-lab" },
    agent: { agentId: "ag-cancel-ok", adapterKind: "antigravity", capabilities: { cancel: "supported" } },
    capabilityRevision: { revisionId: "rev-review-1", capability: "review.diff@1" },
  });
  await seedBaselineEntities(store, {
    principal: { principalId: "other-caller" },
    agent: { agentId: "ag-no-cancel", adapterKind: "legacy", capabilities: { cancel: "unsupported" } },
  });
  const engine = createTaskEngine(store);
  return { store, engine };
}

test("a stop nobody confirmed is reconcile-due even while the dispatch lease is open", () => {
  // 0.9.0 live (acceptance run 10): `needs_reconcile` after `cancel.unconfirmed` still had a live
  // dispatch lease, and the phase read `machine/working` — the operator was told a machine was
  // working while nobody could vouch for the stop. The signal outranks the lease.
  const now = Date.parse("2026-11-18T12:00:00Z");
  const phase = derivePhase(
    { status: "needs_reconcile", leaseExpiresAt: "2026-11-18T12:05:00Z" },
    [],
    { type: "cancel.unconfirmed" },
    { nowMs: now },
  );
  assert.equal(phase.phase, "person/reconcile", "an unconfirmed stop must not read as an active machine");
  assert.equal(phase.label, "Needs reconciliation");
});

test("two ready reports for one task ask one review question", async () => {
  const { store, engine } = await setupEngine();
  try {
    const t = await engine.submit({
      idempotencyKey: "dup-review-1",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
    });
    const att = await engine.recordAttemptStart({ taskId: t.taskId, expectedStateVersion: 1 });
    const report = { state: "ready", result: { raw: "no schema" }, resultValid: false };

    const first = await applyReport(store, {
      taskId: t.taskId,
      attemptId: att.attemptId,
      adapterEventId: "ev-ready-dup-a",
      report,
    });
    const second = await applyReport(store, {
      taskId: t.taskId,
      attemptId: att.attemptId,
      adapterEventId: "ev-ready-dup-b",
      report,
    });
    assert.equal(first.reportInvalid, true);
    assert.equal(second.reportInvalid, true);
    assert.equal(second.questionId, first.questionId, "the same problem must reuse the open question");

    const detail = await engine.get({ taskId: t.taskId });
    assert.equal(detail.status, "running");
    assert.equal(detail.pending.attention.length, 1, "one problem, one question");
    assert.equal(detail.pending.attention[0].kind, "review");

    const events = await engine.events({ taskId: t.taskId, afterSeq: 0 });
    assert.equal(
      events.events.filter((evt) => evt.type === "report.invalid").length,
      2,
      "both reports stay on the record even though the question is reused",
    );
  } finally {
    store.close();
  }
});

test("submit enforces per-(principalId, idempotencyKey) idempotency and detects payload conflict", async () => {
  const { store, engine } = await setupEngine();
  try {
    const first = await engine.submit({
      idempotencyKey: "k-same",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
      input: { base: "a", head: "b" },
    });
    assert.equal(first.status, "queued");
    assert.equal(first.stateVersion, 1);
    assert.equal(first.deduplicated, false);

    // Same principal, same key, logically identical payload (different property order) -> deduplicated
    const replay = await engine.submit({
      idempotencyKey: "k-same",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
      input: { head: "b", base: "a" },
    });
    assert.equal(replay.taskId, first.taskId);
    assert.equal(replay.deduplicated, true);

    // Same principal, same key, different payload -> IDEMPOTENCY_CONFLICT
    await assert.rejects(
      () =>
        engine.submit({
          idempotencyKey: "k-same",
          capabilityRevisionId: "rev-review-1",
          workspaceId: "ws-lab",
          agentId: "ag-cancel-ok",
          input: { base: "a", head: "DIFFERENT" },
        }),
      (err) => isTaskError(err, TASK_ERROR.IDEMPOTENCY_CONFLICT),
    );

    // Different principal, same key -> distinct task
    const other = await engine.submit({
      principalId: "other-caller",
      idempotencyKey: "k-same",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
      input: { base: "a", head: "DIFFERENT" },
    });
    assert.notEqual(other.taskId, first.taskId);
    assert.equal(other.deduplicated, false);
  } finally {
    store.close();
  }
});

test("cancel + completion race always yields exactly one terminal state regardless of arrival order", async () => {
  const { store, engine } = await setupEngine();
  try {
    // Case A: cancel registered first, then runtime reports dropped(cancelled) -> cancelled; late ready ignored
    const t1 = await engine.submit({
      idempotencyKey: "race-1",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
    });
    const att1 = await engine.recordAttemptStart({ taskId: t1.taskId, expectedStateVersion: 1 });
    const c1 = await engine.cancel({
      taskId: t1.taskId,
      expectedStateVersion: att1.stateVersion,
      idempotencyKey: "c-1",
      reason: "user abort",
    });
    assert.equal(c1.requestAccepted, true);
    assert.equal(c1.status, "cancel_requested");

    const dropped = await applyReport(store, {
      taskId: t1.taskId,
      attemptId: att1.attemptId,
      adapterEventId: "ev-drop-1",
      report: { state: "dropped", droppedBy: "cancelled", evidence: { reason: "USER_CANCELED" } },
    });
    assert.equal(dropped.status, "cancelled");

    const lateReady = await applyReport(store, {
      taskId: t1.taskId,
      attemptId: att1.attemptId,
      adapterEventId: "ev-ready-late",
      report: { state: "ready", result: { summary: "too late" }, resultValid: true },
    });
    assert.equal(lateReady.ignoredLateReport, true);
    assert.equal(lateReady.status, "cancelled");

    const detail1 = await engine.get({ taskId: t1.taskId });
    assert.equal(detail1.status, "cancelled");
    assert.equal(detail1.phase, "done");

    // Case B: cancel registered first, but credible ready arrives before cancel stops it -> review_pending -> succeeded; late dropped ignored
    const t2 = await engine.submit({
      idempotencyKey: "race-2",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
    });
    const att2 = await engine.recordAttemptStart({ taskId: t2.taskId, expectedStateVersion: 1 });
    const c2 = await engine.cancel({
      taskId: t2.taskId,
      expectedStateVersion: att2.stateVersion,
      idempotencyKey: "c-2",
    });
    assert.equal(c2.status, "cancel_requested");

    const readyFirst = await applyReport(store, {
      taskId: t2.taskId,
      attemptId: att2.attemptId,
      adapterEventId: "ev-ready-2",
      report: { state: "ready", result: { issues: [] }, resultValid: true },
    });
    assert.equal(readyFirst.status, "review_pending");

    const resolved = await engine.resolve({
      taskId: t2.taskId,
      expectedStateVersion: readyFirst.stateVersion,
      idempotencyKey: "res-2",
      disposition: "accept",
    });
    assert.equal(resolved.status, "succeeded");

    const lateDrop = await applyReport(store, {
      taskId: t2.taskId,
      attemptId: att2.attemptId,
      adapterEventId: "ev-drop-late",
      report: { state: "dropped", droppedBy: "cancelled" },
    });
    assert.equal(lateDrop.ignoredLateReport, true);
    assert.equal(lateDrop.status, "succeeded");

    const evts2 = await engine.events({ taskId: t2.taskId, afterSeq: 0 });
    assert.equal(evts2.events[evts2.events.length - 1].type, "report.late");
  } finally {
    store.close();
  }
});

test("cancel on executor without cancel support enters needs_reconcile with cancel.unsupported", async () => {
  const { store, engine } = await setupEngine();
  try {
    const t = await engine.submit({
      idempotencyKey: "unsup-1",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-no-cancel",
    });
    const att = await engine.recordAttemptStart({ taskId: t.taskId, expectedStateVersion: 1 });

    const cancelRes = await engine.cancel({
      taskId: t.taskId,
      expectedStateVersion: att.stateVersion,
      idempotencyKey: "cancel-unsup-1",
      reason: "stop requested",
    });
    assert.equal(cancelRes.requestAccepted, true);
    assert.equal(cancelRes.status, "needs_reconcile");
    assert.equal(cancelRes.unsupported, true);
    assert.match(cancelRes.notice, /无法停止/);

    // Repeated cancel with same idempotencyKey returns cached receipt
    const replay = await engine.cancel({
      taskId: t.taskId,
      expectedStateVersion: att.stateVersion,
      idempotencyKey: "cancel-unsup-1",
      reason: "stop requested",
    });
    assert.equal(replay.deduplicated, true);
    // Same key with a different request is a conflict, not a silent replay.
    await assert.rejects(
      () =>
        engine.cancel({
          taskId: t.taskId,
          expectedStateVersion: att.stateVersion,
          idempotencyKey: "cancel-unsup-1",
          reason: "a different reason",
        }),
      /different cancel request/,
    );
    assert.equal(replay.status, "needs_reconcile");

    const detail = await engine.get({ taskId: t.taskId });
    assert.equal(detail.status, "needs_reconcile");
    assert.equal(detail.phase, "person/reconcile");
    assert.match(detail.notice, /无法停止/);

    const evts = await engine.events({ taskId: t.taskId, afterSeq: 0 });
    assert.ok(evts.events.some((e) => e.type === "cancel.unsupported"));
  } finally {
    store.close();
  }
});

test("ready with failed schema validation keeps running, writes report.invalid, and opens review attention", async () => {
  const { store, engine } = await setupEngine();
  try {
    const t = await engine.submit({
      idempotencyKey: "invalid-rep-1",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
    });
    const att = await engine.recordAttemptStart({ taskId: t.taskId, expectedStateVersion: 1 });

    const res = await applyReport(store, {
      taskId: t.taskId,
      attemptId: att.attemptId,
      adapterEventId: "ev-bad-schema",
      report: {
        state: "ready",
        result: { raw: "bad" },
        resultValid: false,
        validationErrors: ["missing required field: summary"],
      },
    });
    assert.equal(res.reportInvalid, true);
    assert.equal(res.status, "running");

    const detail = await engine.get({ taskId: t.taskId });
    assert.equal(detail.status, "running");
    assert.equal(detail.phase, "person/review");
    assert.equal(detail.pending.attention.length, 1);
    assert.equal(detail.pending.attention[0].kind, "review");

    const evts = await engine.events({ taskId: t.taskId, afterSeq: 0 });
    assert.ok(evts.events.some((e) => e.type === "report.invalid"));
  } finally {
    store.close();
  }
});

test("derivePhase covers all §5.4 rules and enforces top-to-bottom precedence", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");

  // 1. person/delivery beats approval & question
  assert.equal(
    derivePhase(
      { status: "waiting_approval", undeliveredInputCount: 1 },
      [{ kind: "approval", status: "open" }],
      null,
      { nowMs: now },
    ).phase,
    "person/delivery",
  );
  assert.equal(
    derivePhase({ status: "running" }, [], { type: "input.queued" }, { nowMs: now }).phase,
    "person/delivery",
  );

  // 2. person/approval beats person/answer (§5.2 & §5.4)
  assert.equal(
    derivePhase(
      { status: "waiting_approval" },
      [
        { kind: "input", status: "open" },
        { kind: "approval", status: "open" },
      ],
      null,
      { nowMs: now },
    ).phase,
    "person/approval",
  );

  // 3. person/reconcile outranks leftover questions once the stop is untrusted (0.9.0 live:
  //    `needs_reconcile` + open `input` attention + lastEvent `cancel.unconfirmed` reported
  //    `person/answer`, hiding the reconcile duty).
  assert.equal(
    derivePhase(
      { status: "needs_reconcile" },
      [{ kind: "input", status: "open" }],
      { type: "cancel.unconfirmed" },
      { nowMs: now },
    ).phase,
    "person/reconcile",
  );

  // 4. person/answer for open decision or input (when nothing reconcile-due is pending)
  assert.equal(
    derivePhase({ status: "waiting_input" }, [{ kind: "decision", status: "open" }], null, { nowMs: now }).phase,
    "person/answer",
  );

  // 5. person/reconcile is the status itself, not a function of the lease or the last event:
  //    whoever sees `needs_reconcile` owes a decision, so a still-open lease must not read as
  //    "a machine is working on it" (0.9.0 run 10) and an unlisted reason must not fall through
  //    to `machine/working` (0.9.1 review: `dispatch.failed` / `inspect.unknown` did).
  for (const leaseExpiresAt of ["2026-11-18T12:05:00Z", "2026-11-18T11:59:00Z", undefined]) {
    assert.equal(
      derivePhase({ status: "needs_reconcile", leaseExpiresAt }, [], null, { nowMs: now }).phase,
      "person/reconcile",
    );
  }

  // 6. person/review
  assert.equal(derivePhase({ status: "review_pending" }, [], null, { nowMs: now }).phase, "person/review");

  // 7. machine/queued
  assert.equal(derivePhase({ status: "queued" }, [], null, { nowMs: now }).phase, "machine/queued");
  assert.equal(derivePhase({ status: "dispatching" }, [], null, { nowMs: now }).phase, "machine/queued");

  // 8. machine/working (also when waiting_input has no open attention: never falsely displays person/*)
  assert.equal(derivePhase({ status: "running" }, [], null, { nowMs: now }).phase, "machine/working");
  assert.equal(derivePhase({ status: "waiting_input" }, [], null, { nowMs: now }).phase, "machine/working");

  // 9. done
  assert.equal(derivePhase({ status: "succeeded" }, [], null, { nowMs: now }).phase, "done");
  assert.equal(derivePhase({ status: "failed" }, [], null, { nowMs: now }).phase, "done");
  assert.equal(derivePhase({ status: "cancelled" }, [], null, { nowMs: now }).phase, "done");
});

test("reopening the same SQLite file preserves task state, state_version, and monotonic event sequence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tasks-reopen-"));
  const dbPath = join(dir, "tasks.db");

  let taskId;
  let stateVersionAfterCancel;

  const first = await setupEngine(dbPath);
  try {
    const submitted = await first.engine.submit({
      idempotencyKey: "reopen-1",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
    });
    taskId = submitted.taskId;
    const att = await first.engine.recordAttemptStart({ taskId, expectedStateVersion: submitted.stateVersion });
    const cancelled = await first.engine.cancel({
      taskId,
      expectedStateVersion: att.stateVersion,
      idempotencyKey: "reopen-cancel-1",
      reason: "before restart",
    });
    stateVersionAfterCancel = cancelled.stateVersion;
  } finally {
    first.store.close();
  }

  // Reopen in a fresh store + engine instance
  const reopenedStore = openStore({ path: dbPath });
  const reopenedEngine = createTaskEngine(reopenedStore);
  try {
    const loaded = await reopenedEngine.get({ taskId });
    assert.equal(loaded.status, "cancel_requested");
    assert.equal(loaded.stateVersion, stateVersionAfterCancel);

    const listed = await reopenedEngine.list({ status: "cancel_requested" });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].taskId, taskId);

    const finished = await applyReport(reopenedStore, {
      taskId,
      attemptId: loaded.activeAttemptId,
      adapterEventId: "post-restart-drop",
      report: { state: "dropped", droppedBy: "cancelled" },
    });
    assert.equal(finished.status, "cancelled");
    assert.equal(finished.stateVersion, stateVersionAfterCancel + 1);

    const evts = await reopenedEngine.events({ taskId, afterSeq: 0 });
    const seqs = evts.events.map((e) => e.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  } finally {
    reopenedStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RPC dispatcher wires dsh.tasks.submit/get/list/cancel and updates METHOD_CATALOG", async () => {
  const { store, engine } = await setupEngine();
  try {
    // The breaker is on by default, and a disabled task centre hides its own
    // methods — so a test of the wiring has to enable it, exactly like a real
    // deployment would.
    const methods = createMethods(
      { sessionController: {}, webServer: { getOrigin: () => "http://127.0.0.1:0" }, taskStore: store, taskEngine: engine },
      resolveConfig({ tasksEnabled: true }),
      { get: () => undefined },
      {},
    );
    const dispatch = buildDispatcher(methods);

    const info = await dispatch("dsh.discover", {});
    const catalogNames = info.methods.map((m) => m.name);
    for (const name of ["dsh.tasks.submit", "dsh.tasks.get", "dsh.tasks.list", "dsh.tasks.cancel"]) {
      assert.ok(catalogNames.includes(name), `METHOD_CATALOG missing ${name}`);
    }

    const created = await dispatch("dsh.tasks.submit", {
      idempotencyKey: "rpc-1",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
    });
    assert.equal(created.status, "queued");

    const fetched = await dispatch("dsh.tasks.get", { taskId: created.taskId });
    assert.equal(fetched.taskId, created.taskId);

    const listed = await dispatch("dsh.tasks.list", { workspaceId: "ws-lab" });
    assert.equal(listed.items.length, 1);

    const cancelled = await dispatch("dsh.tasks.cancel", {
      taskId: created.taskId,
      expectedStateVersion: created.stateVersion,
      idempotencyKey: "rpc-cancel-1",
    });
    assert.equal(cancelled.requestAccepted, true);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.alreadyStopped, true);
  } finally {
    store.close();
  }
});

test("withdrawing a queued task that was never dispatched is final immediately (§5.2)", async () => {
  const { store, engine } = await setupEngine();
  try {
    const task = await engine.submit({
      idempotencyKey: "wd-1",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
      input: { base: "a", head: "b" },
    });
    assert.equal(task.status, "queued");
    assert.equal(task.stateVersion, 1);

    const receipt = await engine.cancel({
      taskId: task.taskId,
      expectedStateVersion: task.stateVersion,
      idempotencyKey: "wd-cancel-1",
      reason: "changed my mind",
    });
    assert.equal(receipt.status, "cancelled");
    assert.equal(receipt.alreadyStopped, true);
    assert.equal(receipt.unsupported, false);
    assert.equal(receipt.deduplicated, false);

    const after = await engine.get({ taskId: task.taskId });
    assert.equal(after.status, "cancelled");
    assert.equal(after.phase, "done");
    assert.equal(after.stateVersion, 2);
    assert.equal(after.cancelReason, "changed my mind");

    const events = await engine.events({ taskId: task.taskId, afterSeq: 0 });
    const confirmed = events.events.find((evt) => evt.type === "cancel.confirmed");
    assert.ok(confirmed, "cancel.confirmed event must be recorded");
    assert.equal(confirmed.payload.withdrawnBeforeDispatch, true);

    // Replaying the same cancel key is a deduplicated no-op, not a conflict.
    const replay = await engine.cancel({
      taskId: task.taskId,
      expectedStateVersion: 2,
      idempotencyKey: "wd-cancel-1",
      reason: "changed my mind",
    });
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.status, "cancelled");
  } finally {
    store.close();
  }
});

test("resolve adjudicates an unvalidated ready result through review.promoted", async () => {
  const { store, engine } = await setupEngine();
  try {
    const t = await engine.submit({
      idempotencyKey: "adjudicate-1",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
    });
    const att = await engine.recordAttemptStart({ taskId: t.taskId, expectedStateVersion: 1 });
    const report = await applyReport(store, {
      taskId: t.taskId,
      attemptId: att.attemptId,
      adapterEventId: "ev-unschema",
      report: { state: "ready", result: { raw: "no schema" }, resultValid: false },
    });
    assert.equal(report.reportInvalid, true);

    const before = await engine.get({ taskId: t.taskId });
    assert.equal(before.status, "running");
    assert.equal(before.pending.attention.length, 1);
    assert.equal(before.pending.attention[0].kind, "review");

    // The open review attention is the operator's licence to adjudicate: the resolve
    // must promote to review_pending first, then apply the disposition.
    const resolved = await engine.resolve({
      taskId: t.taskId,
      expectedStateVersion: before.stateVersion,
      idempotencyKey: "adjudicate-accept-1",
      disposition: "accept",
      note: "operator read the raw reply and accepted it",
    });
    assert.equal(resolved.status, "succeeded");
    assert.equal(resolved.resultValid, false);
    assert.equal(resolved.pending.attention.length, 0);

    const evts = await engine.events({ taskId: t.taskId, afterSeq: 0 });
    const types = evts.events.map((e) => e.type);
    const promotedAt = types.indexOf("review.promoted");
    const resolvedAt = types.indexOf("task.resolved");
    assert.ok(promotedAt >= 0, "review.promoted must be recorded");
    assert.ok(resolvedAt > promotedAt, "the promotion must precede the resolution");
    const promoted = evts.events[promotedAt];
    assert.equal(promoted.payload.promotedFrom, "running");
    assert.equal(promoted.payload.resultValid, false);
    assert.equal(promoted.payload.questionId, before.pending.attention[0].questionId);
  } finally {
    store.close();
  }
});

test("resolve keeps refusing a running task that has no open review attention", async () => {
  const { store, engine } = await setupEngine();
  try {
    const t = await engine.submit({
      idempotencyKey: "adjudicate-2",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
    });
    const att = await engine.recordAttemptStart({ taskId: t.taskId, expectedStateVersion: 1 });
    await assert.rejects(
      () =>
        engine.resolve({
          taskId: t.taskId,
          expectedStateVersion: att.stateVersion,
          idempotencyKey: "adjudicate-accept-2",
          disposition: "accept",
        }),
      /cannot be resolved/,
    );
    const detail = await engine.get({ taskId: t.taskId });
    assert.equal(detail.status, "running");
  } finally {
    store.close();
  }
});

test("needs_reconcile always reports person/reconcile, whatever produced it", () => {
  const now = Date.parse("2026-11-19T12:00:00Z");
  // Every recorded reason, plus the two dispatcher-side ones (`dispatch.failed`,
  // `inspect.unknown`) that a whitelist of cancel events used to miss.
  const reasons = [
    "cancel.unconfirmed",
    "cancel.failed",
    "cancel.unsupported",
    "dispatch.orphaned",
    "dispatch.failed",
    "inspect.unknown",
    "lease.expired",
    null,
  ];
  for (const type of reasons) {
    assert.equal(
      derivePhase({ status: "needs_reconcile" }, [], type ? { type } : null, { nowMs: now }).phase,
      "person/reconcile",
      `${type ?? "no last event"} must route to person/reconcile`,
    );
  }
  // A lease still in the future must not hide the duty either (0.9.0 acceptance run 10).
  assert.equal(
    derivePhase(
      { status: "needs_reconcile", leaseExpiresAt: "2099-01-01T00:00:00Z" },
      [],
      { type: "cancel.unconfirmed" },
      { nowMs: now },
    ).phase,
    "person/reconcile",
  );
});

test("an unvalidated result is visible while the operator decides, and acceptance keeps it unvalidated", async () => {
  // 0.9.2 复核 NOTES：接受一个没过校验的结果之后，任务终态里 result 是 null——签收了却
  // 看不见签收的是什么。现在结果落库、resultValid 保持 false，事件里如实写 acceptedUnvalidated。
  const { store, engine } = await setupEngine();
  try {
    const t = await engine.submit({
      idempotencyKey: "invalid-result-visible",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
    });
    const att = await engine.recordAttemptStart({ taskId: t.taskId, expectedStateVersion: 1 });
    await applyReport(store, {
      taskId: t.taskId,
      attemptId: att.attemptId,
      adapterEventId: "ev-invalid-1",
      report: { state: "ready", result: { draft: "half-written summary" }, resultValid: false },
    });

    const running = await engine.get({ taskId: t.taskId });
    assert.equal(running.status, "running");
    assert.deepEqual(running.result, { draft: "half-written summary" }, "the operator must see what is being judged");
    assert.equal(running.resultValid, false, "visible is not the same as validated");
    assert.equal(running.pending.attention.length, 1);

    const resolved = await engine.resolve({
      taskId: t.taskId,
      expectedStateVersion: running.stateVersion,
      idempotencyKey: "invalid-result-accept",
      disposition: "accept",
      note: "the draft is what we asked for, schema check was too strict",
    });
    assert.equal(resolved.status, "succeeded");
    assert.deepEqual(resolved.result, { draft: "half-written summary" }, "acceptance must not discard the result");
    assert.equal(resolved.resultValid, false);

    const events = await engine.events({ taskId: t.taskId, afterSeq: 0 });
    const last = events.events.at(-1);
    assert.equal(last.type, "task.resolved");
    assert.equal(last.payload.resultValid, false);
    assert.equal(last.payload.acceptedUnvalidated, true);
  } finally {
    store.close();
  }
});

test("the same question from a different option set is a different question", async () => {
  // 0.9.2：去重键补了 attempt_id 与 options_json。同一遍里的重复轮询仍只问一次，但可选项变了
  // 就是另一个问题，不能拿旧的顶替。
  const { store, engine } = await setupEngine();
  try {
    const t = await engine.submit({
      idempotencyKey: "attention-granularity",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-cancel-ok",
    });
    const att = await engine.recordAttemptStart({ taskId: t.taskId, expectedStateVersion: 1 });
    const blocked = (options, adapterEventId) =>
      applyReport(store, {
        taskId: t.taskId,
        attemptId: att.attemptId,
        adapterEventId,
        report: { state: "blocked", attention: { kind: "input", prompt: "pick a channel", options } },
      });

    const first = await blocked(["draft", "publish"], "ev-blocked-1");
    const again = await blocked(["draft", "publish"], "ev-blocked-2");
    assert.equal(again.questionId, first.questionId, "the same options must reuse the open question");

    const wider = await blocked(["draft", "publish", "schedule"], "ev-blocked-3");
    assert.notEqual(wider.questionId, first.questionId, "different options are a different question");

    const detail = await engine.get({ taskId: t.taskId });
    assert.equal(detail.pending.attention.length, 2);
  } finally {
    store.close();
  }
});