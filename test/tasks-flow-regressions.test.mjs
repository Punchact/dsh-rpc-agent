// Regressions from the first live end-to-end run (2026-11-19).
//
// Three things the offline suites could not see, because they only appear once a real
// executor is polled in a loop:
//
//   1. an inspect() poll re-describes the same state on every pass — without a stable id
//      the ledger treats each pass as news (the live run recorded 46 `report.invalid`
//      and minted a review question for every one of them);
//   2. two reports carrying the same question minted two questions;
//   3. a stop the executor accepted but never confirmed left the task in
//      `cancel_requested` forever.
import assert from "node:assert/strict";
import test from "node:test";

import { createDispatcher } from "../dist/lib/tasks/dispatch.mjs";
import { createTaskEngine, seedBaselineEntities } from "../dist/lib/tasks/engine.mjs";
import { openStore } from "../dist/lib/tasks/store.mjs";

function makeAdapter(overrides = {}) {
  return {
    async probe() {
      return { ok: true };
    },
    async start() {
      return { accepted: true, locator: { kind: "fake", remoteId: "rem-1" } };
    },
    async inspect() {
      return overrides.inspect ?? { report: { state: "progress" }, adapterEventId: null };
    },
    async sendInput() {
      return { accepted: true };
    },
    async cancel() {
      return overrides.cancel ?? { requestAccepted: true };
    },
    async events(ctx, locator, cursor) {
      return overrides.events ? overrides.events(ctx, locator, cursor) : { events: [], nextCursor: cursor ?? 0 };
    },
    async decideApproval() {
      return { accepted: true };
    },
  };
}

async function setup(adapter) {
  const store = openStore({ path: ":memory:" });
  await seedBaselineEntities(store, {
    principal: { principalId: "local-operator" },
    workspace: { workspaceId: "ws-1", rootPath: "C:\\ws-1" },
    agent: { agentId: "ag-1", adapterKind: "fake", capabilities: { cancel: "supported" } },
    capabilityRevision: { revisionId: "cap-1", capability: "review.diff@1" },
  });
  const engine = createTaskEngine(store);
  const dispatcher = createDispatcher({ store, engine, adapters: { fake: adapter } });
  const task = await engine.submit({
    idempotencyKey: "flow-1",
    capabilityRevisionId: "cap-1",
    workspaceId: "ws-1",
    agentId: "ag-1",
    principalId: "local-operator",
    input: { prompt: "do the thing" },
  });
  await dispatcher.startTask({ taskId: task.taskId });
  return { store, engine, dispatcher, taskId: task.taskId };
}

function countAttention(store, taskId) {
  return store.read((db) =>
    db.prepare("SELECT COUNT(*) AS n FROM attention WHERE task_id = ?").get(taskId),
  ).n;
}

function eventTypes(store, taskId, type) {
  return store.read((db) =>
    db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = ?")
      .get(taskId, type),
  ).n;
}

test("a repeated inspect poll with the same adapterEventId is applied once", async () => {
  // `ready` without a validated result is exactly what the live DSH adapter reports for a
  // finished turn, and exactly what minted 46 review questions in the live run.
  const report = {
    state: "ready",
    resultValid: false,
    reason: "turn ended without validated task result",
  };
  const { store, dispatcher, taskId } = await setup(
    makeAdapter({ inspect: { report, adapterEventId: "status:sess-1:completed:idle:-" } }),
  );

  await dispatcher.pump({ taskId, maxSteps: 1 });
  const afterFirst = countAttention(store, taskId);
  await dispatcher.pump({ taskId, maxSteps: 1 });
  await dispatcher.pump({ taskId, maxSteps: 1 });
  const afterThird = countAttention(store, taskId);

  assert.equal(afterFirst, 1, "the first poll should post exactly one question");
  assert.equal(afterThird, 1, "later polls of the same state must not add questions");
  assert.equal(
    eventTypes(store, taskId, "report.invalid"),
    1,
    "the invalid report is recorded once, not once per poll",
  );
});

test("two reports carrying the same question reuse one open attention row", async () => {
  let served = 0;
  const adapter = makeAdapter({
    events: () => {
      served += 1;
      if (served > 1) return { events: [], nextCursor: served };
      const report = {
        state: "waiting",
        attention: { kind: "input", prompt: "which environment should I use?" },
      };
      return {
        events: [
          { report, adapterEventId: "wait-1" },
          { report, adapterEventId: "wait-2" },
        ],
        nextCursor: 1,
      };
    },
  });
  const { store, engine, dispatcher, taskId } = await setup(adapter);

  await dispatcher.pump({ taskId, maxSteps: 4 });

  const detail = await engine.get({ taskId });
  assert.equal(detail.status, "waiting_input");
  assert.equal(countAttention(store, taskId), 1, "one question, not one per report");
  const open = store.read((db) =>
    db.prepare("SELECT prompt FROM attention WHERE task_id = ? AND status = 'open'").all(taskId),
  );
  assert.deepEqual(open.map((row) => row.prompt), ["which environment should I use?"]);
});

test("a stop nobody confirmed escalates to needs_reconcile instead of hanging", async () => {
  // Adapters report `requestAccepted` when the request was queued, and `confirmedStopped`
  // only when the executor itself proved the stop.
  const { store, engine, dispatcher, taskId } = await setup(makeAdapter());

  const detail = await engine.get({ taskId });
  const cancelled = await engine.cancel({
    taskId,
    expectedStateVersion: detail.stateVersion,
    idempotencyKey: "cancel-1",
    reason: "operator asked",
  });
  assert.equal(cancelled.status, "cancel_requested");

  await dispatcher.drainEffects({ limit: 5 });

  const after = await engine.get({ taskId });
  assert.equal(after.status, "needs_reconcile");
  assert.equal(eventTypes(store, taskId, "cancel.unconfirmed"), 1);
});
