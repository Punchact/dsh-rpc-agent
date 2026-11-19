import assert from "node:assert/strict";
import test from "node:test";

import { createDshAdapter } from "../dist/lib/adapters/dsh.mjs";
import { createDispatcher } from "../dist/lib/tasks/dispatch.mjs";
import { createTaskEngine, seedBaselineEntities } from "../dist/lib/tasks/engine.mjs";
import { TASK_ERROR, isTaskError } from "../dist/lib/tasks/errors.mjs";
import { createPreview } from "../dist/lib/tasks/preview.mjs";
import { openStore } from "../dist/lib/tasks/store.mjs";

function makeOps(overrides = {}) {
  const calls = [];
  const ops = {
    async createSession(params) {
      calls.push(["createSession", params]);
      return { ok: true, sessionId: "sess_dsh_1" };
    },
    async askSession(params) {
      calls.push(["askSession", params]);
      return { ok: true, accepted: true, status: "running", requestId: "req_1" };
    },
    async promptSession(params) {
      calls.push(["promptSession", params]);
      return { ok: true, accepted: true, requestId: "req_2" };
    },
    async cancelSession(params) {
      calls.push(["cancelSession", params]);
      return { ok: true, accepted: true, stopped: false };
    },
    async sessionStatus(params) {
      calls.push(["sessionStatus", params]);
      return { ok: true, sessionId: params?.sessionId ?? "sess_dsh_1", status: "running", running: true };
    },
    async sessionHistory(params) {
      calls.push(["sessionHistory", params]);
      return { ok: true, sessionId: params?.sessionId ?? "sess_dsh_1", cursor: 0, records: [] };
    },
    async resolveApproval(params) {
      calls.push(["resolveApproval", params]);
      return { ok: true, resolved: true, accepted: true, approvalId: params.approvalId, decision: "allow-once" };
    },
    ...overrides,
  };
  return { ops, calls };
}

test("createDshAdapter rejects missing ops or missing required op with INVALID_ADAPTER", () => {
  assert.throws(
    () => createDshAdapter({}),
    (err) => isTaskError(err, TASK_ERROR.INVALID_ADAPTER),
  );
  assert.throws(
    () => createDshAdapter({ ops: null }),
    (err) => isTaskError(err, TASK_ERROR.INVALID_ADAPTER),
  );
  const { ops } = makeOps();
  delete ops.resolveApproval;
  assert.throws(
    () => createDshAdapter({ ops }),
    (err) => isTaskError(err, TASK_ERROR.INVALID_ADAPTER),
  );
});

test("dsh adapter probe is read-only (never calls createSession or askSession) and reports failures", async () => {
  const { ops, calls } = makeOps();
  const adapter = createDshAdapter({ ops });

  const okRes = await adapter.probe();
  assert.equal(okRes.ok, true);
  assert.equal(okRes.controls.start, true);
  assert.equal(calls.some(([fn]) => fn === "createSession" || fn === "askSession"), false);
  assert.deepEqual(calls[0], ["sessionStatus", { probe: true }]);

  const failAdapter = createDshAdapter({
    ops: makeOps({
      async sessionStatus() {
        return { ok: false, reason: "controller_offline" };
      },
    }).ops,
  });
  const failRes = await failAdapter.probe();
  assert.equal(failRes.ok, false);
  assert.equal(failRes.reason, "the execution backend is unavailable");
  assert.equal(failRes.reason.includes("controller_offline"), false);
});

test("dsh adapter start creates session, triggers ask, and returns secret-free locator", async () => {
  const { ops, calls } = makeOps();
  const adapter = createDshAdapter({ ops });

  const started = await adapter.start({
    task: { taskId: "t_1", requestSummary: { prompt: "summarize diff", model: "openai/gpt-5" } },
    workspace: { rootPath: "C:\\work\\repo" },
    agent: { adapterConfig: { agentPreset: "coder" } },
  });

  assert.equal(started.accepted, true);
  assert.deepEqual(started.locator, { kind: "dsh", sessionId: "sess_dsh_1" });
  assert.equal(calls[0][0], "createSession");
  assert.equal(calls[0][1].cwd, "C:\\work\\repo");
  assert.equal(calls[0][1].agentPreset, "coder");
  assert.equal(calls[1][0], "askSession");
  assert.equal(calls[1][1].sessionId, "sess_dsh_1");
  assert.equal(calls[1][1].prompt, "summarize diff");
});

test("dsh adapter inspect maps all session statuses to honest 6-state reports", async () => {
  let nextStatus = { ok: true, status: "running", running: true, turn: 1 };
  const { ops } = makeOps({
    async sessionStatus() {
      return nextStatus;
    },
  });
  const adapter = createDshAdapter({ ops });
  const locator = { kind: "dsh", sessionId: "sess_map_1" };

  const firstPoll = await adapter.inspect(locator);
  assert.equal(firstPoll.report.state, "progress");
  // §5.3 idempotency: the id must describe the observed state, not the moment of asking,
  // otherwise every poll looks like news to the ledger (live run: 46 duplicate questions).
  assert.match(firstPoll.adapterEventId, /^status:sess_map_1:/);
  assert.equal((await adapter.inspect(locator)).adapterEventId, firstPoll.adapterEventId);

  nextStatus = {
    ok: true,
    status: "waiting_approval",
    running: true,
    pendingApproval: { approvalId: "apr_1", toolName: "bash", prompt: "Allow bash?" },
  };
  const blockedApproval = (await adapter.inspect(locator)).report;
  assert.equal(blockedApproval.state, "blocked");
  assert.equal(blockedApproval.attention.kind, "approval");
  assert.equal(blockedApproval.attention.approvalId, "apr_1");

  nextStatus = { ok: true, status: "completed", running: false, turn: 1 };
  const readyUnvalidated = (await adapter.inspect(locator)).report;
  assert.equal(readyUnvalidated.state, "ready");
  // Must stay false until an explicit schema-validated result exists.
  assert.equal(readyUnvalidated.resultValid, false);

  nextStatus = { ok: true, status: "failed", running: false, error: "model crashed" };
  const failed = (await adapter.inspect(locator)).report;
  assert.equal(failed.state, "failed");
  assert.equal(failed.reason, "model crashed");

  nextStatus = { ok: true, status: "cancelled", running: false };
  const cancelled = (await adapter.inspect(locator)).report;
  assert.equal(cancelled.state, "dropped");
  assert.equal(cancelled.droppedBy, "cancelled");

  nextStatus = { ok: true, status: "mystery_state", running: false };
  const unknown = (await adapter.inspect(locator)).report;
  assert.equal(unknown.state, "blocked");
  assert.equal(unknown.failureClass, "unknown_status");
});

test("dsh adapter events preserves exact cursor, adapterEventId, and maps turn/end, approval/*, and tool/result errors", async () => {
  const { ops, calls } = makeOps({
    async sessionHistory(params) {
      calls.push(["sessionHistory", params]);
      return {
        ok: true,
        sessionId: params.sessionId,
        cursor: 42,
        records: [
          { seq: 10, type: "tool/result", data: { toolName: "fs_read", isError: true, error: "ENOENT" } },
          {
            seq: 11,
            type: "approval/requested",
            data: { approvalId: "apr_99", toolName: "bash", prompt: "Run command?" },
          },
          { seq: 12, type: "turn/end", data: { reason: { kind: "completed" } } },
          { seq: 13, type: "turn/end", data: { reason: { kind: "failed", message: "boom" } } },
        ],
      };
    },
  });
  const adapter = createDshAdapter({ ops });
  const res = await adapter.events({ kind: "dsh", sessionId: "sess_ev_1" }, 9);

  assert.equal(calls[0][1].afterSeq, 9);
  assert.equal(res.nextCursor, 42);
  assert.equal(res.events.length, 4);

  assert.equal(res.events[0].adapterEventId, "sess_ev_1:10:tool/result");
  assert.equal(res.events[0].report.state, "progress");
  assert.equal(res.events[0].report.evidence.isError, true);

  assert.equal(res.events[1].adapterEventId, "sess_ev_1:11:approval/requested");
  assert.equal(res.events[1].report.state, "blocked");
  assert.equal(res.events[1].report.attention.kind, "approval");

  assert.equal(res.events[2].adapterEventId, "sess_ev_1:12:turn/end");
  assert.equal(res.events[2].report.state, "ready");
  assert.equal(res.events[2].report.resultValid, false);

  assert.equal(res.events[3].adapterEventId, "sess_ev_1:13:turn/end");
  assert.equal(res.events[3].report.state, "failed");
});

test("dsh adapter sendInput uses steer mode, cancel stays honest about stopped, decideApproval validates approvalId", async () => {
  let stopConfirmed = false;
  const { ops, calls } = makeOps({
    async cancelSession(params) {
      calls.push(["cancelSession", params]);
      return { ok: true, accepted: true, stopped: stopConfirmed };
    },
  });
  const adapter = createDshAdapter({ ops });
  const locator = { kind: "dsh", sessionId: "sess_ctl_1" };

  const steerRes = await adapter.sendInput(locator, { text: "continue cleanly" });
  assert.equal(steerRes.accepted, true);
  assert.equal(steerRes.mode, "steer");
  assert.equal(calls.at(-1)[1].mode, "steer");

  const cancelUnconfirmed = await adapter.cancel(locator);
  assert.equal(cancelUnconfirmed.requestAccepted, true);
  assert.equal(cancelUnconfirmed.stopped, false);

  stopConfirmed = true;
  const cancelConfirmed = await adapter.cancel(locator);
  assert.equal(cancelConfirmed.stopped, true);

  await assert.rejects(
    () => adapter.decideApproval(locator, { decision: "allow-once" }),
    (err) => isTaskError(err, TASK_ERROR.VALIDATION_FAILED),
  );
  const approved = await adapter.decideApproval(locator, {
    approvalId: "apr_2",
    decision: "allow-once",
    reason: "looks safe",
  });
  assert.equal(approved.accepted, true);
  assert.equal(approved.approvalId, "apr_2");
});

test("dsh adapter integrates end-to-end with createTaskEngine and createDispatcher", async () => {
  const store = openStore({ path: ":memory:" });
  const engine = createTaskEngine(store);
  try {
    await seedBaselineEntities(store, {
      principal: { principalId: "local-operator" },
      workspace: { workspaceId: "local", rootPath: "C:\\work\\repo" },
      agent: { agentId: "ag_dsh", adapterKind: "dsh", capabilities: { cancel: "supported" } },
      capabilityRevision: { revisionId: "cap_dsh_run", capability: "dsh.run@1" },
    });
    const preview = await createPreview(store, {
      principalId: "local-operator",
      requestDigest: "dig_dsh_1",
      capabilityRevisionId: "cap_dsh_run",
      workspaceId: "local",
      agentId: "ag_dsh",
    });
    const task = await engine.submit({
      previewId: preview.previewId,
      idempotencyKey: "idem_dsh_1",
      principalId: "local-operator",
      capabilityRevisionId: "cap_dsh_run",
      workspaceId: "local",
      agentId: "ag_dsh",
      input: { prompt: "check repo" },
    });

    const { ops } = makeOps({
      async sessionHistory() {
        return {
          ok: true,
          sessionId: "sess_dsh_1",
          cursor: 3,
          records: [{ seq: 3, type: "turn/end", data: { reason: { kind: "completed" } } }],
        };
      },
    });
    const dispatcher = createDispatcher({
      store,
      engine,
      adapters: { dsh: createDshAdapter({ ops }) },
    });

    const disp = await dispatcher.startTask({ taskId: task.taskId });
    assert.equal(disp.status, "running");
    assert.deepEqual(disp.locator, { kind: "dsh", sessionId: "sess_dsh_1" });

    const pumped = await dispatcher.pump({ taskId: task.taskId, maxSteps: 5 });
    assert.equal(pumped.nextCursor, 3);
    assert.equal(pumped.status, "running");
  } finally {
    store.close();
  }
});

test("approval records that need no decision never block a task (0.9.0 live: approval/policy parked a finished task)", async () => {
  const { ops } = makeOps({
    async sessionHistory(params) {
      return {
        ok: true,
        sessionId: params.sessionId,
        cursor: 4,
        records: [
          // The session's approval policy at start: `{ policy: "ask" }` records how approvals
          // would be requested, not that one is pending.
          { seq: 2, type: "approval/policy", data: { policy: "ask" } },
          // A resolution row can only exist after a decision, so it cannot be pending either.
          { seq: 3, type: "approval/resolved", data: { approvalId: "apr_1", decision: "allow-once" } },
          { seq: 4, type: "turn/end", data: { reason: { kind: "completed" } } },
        ],
      };
    },
  });
  const adapter = createDshAdapter({ ops });
  const res = await adapter.events({ kind: "dsh", sessionId: "sess_policy_1" }, 1);

  assert.equal(res.events.length, 3);
  for (const evt of res.events.slice(0, 2)) {
    assert.equal(evt.report.state, "progress", `${evt.adapterEventId} must not block`);
    assert.equal(evt.report.attention, undefined, `${evt.adapterEventId} must not open an attention`);
  }
  assert.equal(res.events[0].report.evidence.policy, "ask");
  assert.equal(res.events[2].report.state, "ready");
});
