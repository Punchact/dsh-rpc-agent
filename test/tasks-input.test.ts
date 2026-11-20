import assert from "node:assert/strict";
import test from "node:test";

import { isTaskError } from "../dist/lib/tasks/errors.mjs";
import { createTaskEngine, seedBaselineEntities } from "../dist/lib/tasks/engine.mjs";
import { createDispatcher } from "../dist/lib/tasks/dispatch.mjs";
import { openStore } from "../dist/lib/tasks/store.mjs";

interface InputSentRecord {
  target: unknown;
  input: { text?: string; questionId?: string };
}

interface InputEngineView {
  submit(p: Record<string, unknown>): Promise<{ taskId: string }>;
  applyReport(p: Record<string, unknown>): Promise<unknown>;
  get(p: { taskId: string }): Promise<{ status: string; phase: string; stateVersion: number }>;
  input(p: Record<string, unknown>): Promise<{
    taskId: string;
    deliveryStatus: string;
    deduplicated: boolean;
  }>;
  events(p: { taskId: string }): Promise<{ events: Array<{ type: string }> }>;
  resolve(p: Record<string, unknown>): Promise<unknown>;
}

interface InputDispatcherView {
  startTask(p: { taskId: string }): Promise<{ attemptId?: string; attempt?: { attemptId?: string } }>;
  drainEffects(p: { limit: number }): Promise<{ processed: number; completed: number }>;
}

const seedBaseline = seedBaselineEntities as unknown as (
  store: unknown,
  seed: Record<string, unknown>,
) => Promise<void>;
const buildDispatcher = createDispatcher as unknown as (opts: Record<string, unknown>) => InputDispatcherView;

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

async function makeWorld() {
  const store = openStore({ path: ":memory:" });
  await seedBaseline(store, {
    principal: { principalId: "local-operator" },
    workspace: { workspaceId: "ws-lab", rootPath: "C:\\ws-lab" },
    agent: { agentId: "ag-in", adapterKind: "dsh", capabilities: { cancel: "supported" } },
    capabilityRevision: { revisionId: "rev-in-1", capability: "review.diff@1" },
  });
  const engine = createTaskEngine(store) as unknown as InputEngineView;
  const sent: InputSentRecord[] = [];
  const adapter = {
    kind: "dsh",
    async probe() {
      return { ok: true, controls: { start: "supported", steer: "supported" } };
    },
    async start() {
      return { locator: { kind: "dsh", sessionId: "sess-in" } };
    },
    async inspect() {
      return { status: "running" };
    },
    async sendInput(target: unknown, input: { text?: string; questionId?: string }) {
      sent.push({ target, input });
      return { delivered: true };
    },
    async cancel() {
      return { requestAccepted: true, confirmedStopped: true };
    },
    async events() {
      return { events: [], nextCursor: null };
    },
    async decideApproval() {
      return { delivered: true };
    },
  };
  const dispatcher = buildDispatcher({ store, engine, adapters: { dsh: adapter } });
  void silentLogger;
  return { store, engine, dispatcher, sent };
}

async function startTask(engine: InputEngineView, dispatcher: InputDispatcherView, key = "sub-1") {
  const submitted = await engine.submit({
    idempotencyKey: key,
    capabilityRevisionId: "rev-in-1",
    workspaceId: "ws-lab",
    agentId: "ag-in",
    input: { prompt: "run the build" },
  });
  const started = await dispatcher.startTask({ taskId: submitted.taskId });
  return { taskId: submitted.taskId, attemptId: started.attemptId ?? started.attempt?.attemptId ?? null };
}

async function waitForInput(engine: InputEngineView, taskId: string, attemptId: string | null) {
  await engine.applyReport({
    taskId,
    attemptId,
    report: {
      state: "waiting",
      attention: { kind: "input", prompt: "which environment?", questionId: "q_env" },
    },
  });
  const detail = await engine.get({ taskId });
  return detail;
}

test("an answer is queued, delivered through the adapter, and closes the question", async () => {
  const { engine, dispatcher, sent } = await makeWorld();
  const { taskId, attemptId } = await startTask(engine, dispatcher);

  const waiting = await waitForInput(engine, taskId, attemptId);
  assert.equal(waiting.status, "waiting_input");
  assert.equal(waiting.phase, "person/answer");

  const queued = await engine.input({
    taskId,
    idempotencyKey: "in-1",
    text: "staging",
    questionId: "q_env",
  });
  assert.equal(queued.deliveryStatus, "queued");
  assert.equal(queued.deduplicated, false);

  const drained = await dispatcher.drainEffects({ limit: 10 });
  assert.equal(drained.processed, 1);
  assert.equal(drained.completed, 1);
  assert.equal(sent.length, 1);
  const sent0 = sent[0];
  if (!sent0) throw new Error("missing sent[0]");
  assert.equal(sent0.input.text, "staging");
  assert.equal(sent0.input.questionId, "q_env");

  const after = await engine.get({ taskId });
  assert.equal(after.status, "running");
  assert.equal(after.phase, "machine/working");

  const events = await engine.events({ taskId });
  const kinds = events.events.map((event) => event.type);
  assert.ok(kinds.includes("input.queued"));
  assert.ok(kinds.includes("input.delivered"));
});

test("the same key is idempotent, a different answer under it conflicts, and a closed question refuses a second answer", async () => {
  const { engine, dispatcher } = await makeWorld();
  const { taskId, attemptId } = await startTask(engine, dispatcher, "sub-2");
  await waitForInput(engine, taskId, attemptId);

  const first = await engine.input({ taskId, idempotencyKey: "in-2", text: "staging", questionId: "q_env" });
  const replay = await engine.input({ taskId, idempotencyKey: "in-2", text: "staging", questionId: "q_env" });
  assert.equal(replay.taskId, first.taskId);
  assert.equal(replay.deduplicated, true);

  await assert.rejects(
    () => engine.input({ taskId, idempotencyKey: "in-2", text: "production", questionId: "q_env" }),
    (error: { message?: string }) => {
      assert.ok(isTaskError(error), "expected a task error");
      assert.match(error.message ?? "", /different input/);
      return true;
    },
  );

  await dispatcher.startTask({ taskId }).catch(() => {});
  await engine.input({ taskId, idempotencyKey: "in-3", text: "staging", questionId: "q_env" });
  await dispatcher.drainEffects({ limit: 10 });

  await assert.rejects(
    () =>
      engine.input({ taskId, idempotencyKey: "in-4", text: "again", questionId: "q_env" }),
    (error: { message?: string }) => {
      assert.ok(isTaskError(error), "expected a task error");
      assert.match(error.message ?? "", /question/i);
      return true;
    },
  );

  await assert.rejects(
    () => engine.input({ taskId, idempotencyKey: "in-5", text: "x", questionId: "q_missing" }),
    (error: { message?: string }) => {
      assert.ok(isTaskError(error), "expected a task error");
      assert.match(error.message ?? "", /question/i);
      return true;
    },
  );
});

test("an answer is refused when the task has not started, the attempt is stale, or the task is finished", async () => {
  const { engine, dispatcher } = await makeWorld();

  const notStarted = await engine.submit({
    idempotencyKey: "sub-3-idle",
    capabilityRevisionId: "rev-in-1",
    workspaceId: "ws-lab",
    agentId: "ag-in",
    input: { prompt: "run the build" },
  });
  await assert.rejects(
    () => engine.input({ taskId: notStarted.taskId, idempotencyKey: "in-a", text: "too early" }),
    (error: { message?: string }) => {
      assert.ok(isTaskError(error), "expected a task error");
      assert.match(error.message ?? "", /attempt/i);
      return true;
    },
  );

  const { taskId, attemptId } = await startTask(engine, dispatcher, "sub-3");
  await waitForInput(engine, taskId, attemptId);

  await assert.rejects(
    () => engine.input({ taskId, attemptId: "att-nope", idempotencyKey: "in-b", text: "wrong attempt" }),
    (error: { message?: string }) => {
      assert.ok(isTaskError(error), "expected a task error");
      assert.match(error.message ?? "", /attempt/i);
      return true;
    },
  );

  await engine.input({ taskId, idempotencyKey: "in-c", text: "staging", questionId: "q_env" });
  await dispatcher.drainEffects({ limit: 10 });

  await engine.applyReport({ taskId, attemptId, report: { state: "ready", summary: "answered", result: { answer: "staging" } } });
  const reviewed = await engine.get({ taskId });
  assert.equal(reviewed.status, "review_pending");
  await engine.resolve({
    taskId,
    disposition: "accept",
    idempotencyKey: "res-3",
    expectedStateVersion: reviewed.stateVersion,
  });

  await assert.rejects(
    () => engine.input({ taskId, idempotencyKey: "in-d", text: "late" }),
    (error: { message?: string }) => {
      assert.ok(isTaskError(error), "expected a task error");
      assert.match(error.message ?? "", /no longer accepted|finished|succeeded/i);
      return true;
    },
  );
});
