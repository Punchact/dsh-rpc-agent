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
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createDispatcher } from "../dist/lib/tasks/dispatch.mjs";
import { createTaskEngine, seedBaselineEntities } from "../dist/lib/tasks/engine.mjs";
import { openStore } from "../dist/lib/tasks/store.mjs";

interface FakeFlowAdapterOverrides {
  inspect?: { report: Record<string, unknown>; adapterEventId: string | null };
  cancel?: { requestAccepted: boolean; confirmedStopped?: boolean };
  events?: (ctx: unknown, locator: unknown, cursor: unknown) => { events: unknown[]; nextCursor: unknown };
}

const seedBaseline = seedBaselineEntities as unknown as (
  store: unknown,
  seed: Record<string, unknown>,
) => Promise<void>;
const buildDispatcher = createDispatcher as unknown as (opts: Record<string, unknown>) => {
  startTask(opts: { taskId: string }): Promise<unknown>;
  pump(opts: { taskId: string; maxSteps: number }): Promise<unknown>;
  drainEffects(opts: { limit: number }): Promise<unknown>;
};

function makeAdapter(overrides: FakeFlowAdapterOverrides = {}) {
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
    async events(ctx: unknown, locator: unknown, cursor: unknown) {
      return overrides.events ? overrides.events(ctx, locator, cursor) : { events: [], nextCursor: cursor ?? 0 };
    },
    async decideApproval() {
      return { accepted: true };
    },
  };
}

async function setup(adapter: ReturnType<typeof makeAdapter>) {
  const store = openStore({ path: ":memory:" });
  await seedBaseline(store, {
    principal: { principalId: "local-operator" },
    workspace: { workspaceId: "ws-1", rootPath: "C:\\ws-1" },
    agent: { agentId: "ag-1", adapterKind: "fake", capabilities: { cancel: "supported" } },
    capabilityRevision: { revisionId: "cap-1", capability: "review.diff@1" },
  });
  const engine = createTaskEngine(store) as unknown as {
    submit(p: Record<string, unknown>): Promise<{ taskId: string }>;
    get(p: { taskId: string }): Promise<{ status: string; stateVersion: number }>;
    cancel(p: Record<string, unknown>): Promise<{ status: string }>;
  };
  const dispatcher = buildDispatcher({ store, engine, adapters: { fake: adapter } });
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

function countAttention(store: ReturnType<typeof openStore>, taskId: string): number {
  return (
    store.read((db: DatabaseSync) => db.prepare("SELECT COUNT(*) AS n FROM attention WHERE task_id = ?").get(taskId)) as {
      n: number;
    }
  ).n;
}

function eventTypes(store: ReturnType<typeof openStore>, taskId: string, type: string): number {
  return (
    store.read((db: DatabaseSync) =>
      db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = ?").get(taskId, type),
    ) as { n: number }
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
  const open = store.read((db: DatabaseSync) =>
    db.prepare("SELECT prompt FROM attention WHERE task_id = ? AND status = 'open'").all(taskId),
  ) as Array<{ prompt: string }>;
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
