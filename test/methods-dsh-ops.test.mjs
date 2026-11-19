import assert from "node:assert/strict";
import test from "node:test";

import { buildDispatcher } from "../dist/lib/http.mjs";
import { createDshAdapterOps, createMethods } from "../dist/lib/methods.mjs";
import { createTaskEngine, seedBaselineEntities } from "../dist/lib/tasks/engine.mjs";
import { TASK_ERROR, isTaskError } from "../dist/lib/tasks/errors.mjs";
import { createPreview } from "../dist/lib/tasks/preview.mjs";
import { openStore } from "../dist/lib/tasks/store.mjs";

function makeFakeSessionController(overrides = {}) {
  const calls = [];
  let createdSeq = 0;
  return {
    calls,
    sessionController: {
      async create(req) {
        calls.push(["create", req]);
        createdSeq += 1;
        return { sessionId: `sess_${createdSeq}`, agentPreset: req.agentPreset ?? "coder" };
      },
      async prompt(req) {
        calls.push(["prompt", req]);
        return { accepted: true, requestId: req.requestId };
      },
      async cancel(req) {
        calls.push(["cancel", req]);
        return { accepted: true, stopped: false };
      },
      async list() {
        calls.push(["list"]);
        return {
          items: [
            { sessionId: "sess_1", running: true, blank: false },
            { sessionId: "sess_done", running: false, blank: false },
          ],
        };
      },
      async *follow(req) {
        calls.push(["follow", req]);
        yield {
          type: "snapshot",
          cursor: 7,
          hasMore: false,
          records: [
            { seq: 5, type: "turn/start", time: 1000, data: { turn: 1 } },
            { seq: 6, type: "assistant/message", time: 1001, data: { turn: 1, message: { content: "hi" } } },
            { seq: 7, type: "turn/end", time: 1002, data: { turn: 1, reason: { kind: "completed" } } },
          ],
        };
      },
      ...overrides,
    },
  };
}

function validCard(agentId = "ag_1", kind = "dsh") {
  return {
    identity: { agentId, name: agentId, kind, version: "1.0.0" },
    controls: {
      start: { support: "required", evidence: "dsh" },
      steer: { support: "optional", evidence: "steer" },
      cancel: { support: "required", evidence: "cancel" },
      inspect: { support: "required", evidence: "status" },
      approval: { support: "required", evidence: "approvals" },
      events: { support: "required", evidence: "history" },
    },
    limitations: ["single-host"],
  };
}

test("createDshAdapterOps wraps sessionController + approvals without throwing", async () => {
  const { sessionController, calls } = makeFakeSessionController();
  const resolvedCalls = [];
  const approvals = {
    async waitForAny({ sessionId }) {
      return sessionId === "sess_wait_apr"
        ? { pending: [{ approvalId: "apr_7", toolName: "bash" }] }
        : { pending: [] };
    },
    resolve(id, decision, note) {
      resolvedCalls.push({ id, decision, note });
      return id === "apr_7"
        ? { resolved: true, sessionId: "sess_wait_apr", toolName: "bash" }
        : { resolved: false };
    },
  };

  const ops = createDshAdapterOps({
    sessionController,
    config: { defaultCwd: "C:\\repo" },
    approvals,
  });

  const created = await ops.createSession({});
  assert.equal(created.ok, true);
  assert.equal(created.sessionId, "sess_1");

  const asked = await ops.askSession({ sessionId: "sess_1", prompt: "hello" });
  assert.equal(asked.ok, true);
  assert.equal(asked.status, "running");

  const steered = await ops.promptSession({ sessionId: "sess_1", text: "nudge", mode: "steer" });
  assert.equal(steered.ok, true);
  assert.equal(steered.mode, "steer");

  const probeSt = await ops.sessionStatus({ probe: true });
  assert.equal(probeSt.ok, true);
  assert.equal(probeSt.count, 2);

  const runSt = await ops.sessionStatus({ sessionId: "sess_1" });
  assert.equal(runSt.status, "running");

  const aprSt = await ops.sessionStatus({ sessionId: "sess_wait_apr" });
  assert.equal(aprSt.status, "waiting_approval");
  assert.equal(aprSt.pendingApproval.approvalId, "apr_7");

  const doneSt = await ops.sessionStatus({ sessionId: "sess_done" });
  assert.equal(doneSt.status, "completed");

  const hist = await ops.sessionHistory({ sessionId: "sess_done", afterSeq: 5 });
  assert.equal(hist.ok, true);
  assert.equal(hist.cursor, 7);
  assert.equal(hist.records.length, 2);

  const aprOk = await ops.resolveApproval({ approvalId: "apr_7", decision: "allow", reason: "ok" });
  assert.equal(aprOk.ok, true);
  assert.equal(aprOk.decision, "allow-once");
  assert.equal(resolvedCalls[0].decision, "allow-once");

  const aprMiss = await ops.resolveApproval({ approvalId: "missing", decision: "deny" });
  assert.equal(aprMiss.ok, false);

  const cancelRes = await ops.cancelSession({ sessionId: "sess_1" });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.stopped, false);
  assert.ok(calls.some(([m]) => m === "cancel"));

  // Throwing controller errors are caught cleanly into `{ ok: false, reason }`.
  const brokenOps = createDshAdapterOps({
    sessionController: {
      async create() {
        throw new Error("host down");
      },
    },
  });
  const brokenRes = await brokenOps.createSession({});
  assert.equal(brokenRes.ok, false);
  assert.match(brokenRes.reason, /host down/);
});

test("createMethods auto-wires dsh adapter when tasksEnabled=true and validates registerAgent + decideApproval", async () => {
  const store = openStore({ path: ":memory:" });
  const engine = createTaskEngine(store);
  try {
    await seedBaselineEntities(store, {
      principal: { principalId: "local-operator" },
      workspace: { workspaceId: "local", rootPath: "C:\\work\\repo" },
      capabilityRevision: { revisionId: "cap_1", capability: "dsh.test@1" },
    });
    const { sessionController } = makeFakeSessionController();
    const methods = createMethods(
      { sessionController, webServer: { getOrigin: () => "http://127.0.0.1:1" }, taskStore: store, taskEngine: engine },
      { tasksEnabled: true, tasksMaxConcurrent: 2 },
      { logger: { info() {}, warn() {}, error() {}, debug() {} }, get: () => undefined },
      {},
    );

    // Unsupported adapterKind is rejected
    await assert.rejects(
      () => methods.registerAgent({ card: validCard("ag_bad", "custom-runner") }),
      (err) => isTaskError(err, TASK_ERROR.VALIDATION_FAILED),
    );
    // Mismatched top-level adapterKind is rejected
    await assert.rejects(
      () => methods.registerAgent({ adapterKind: "codex", card: validCard("ag_dsh", "dsh") }),
      (err) => isTaskError(err, TASK_ERROR.VALIDATION_FAILED),
    );

    const reg = await methods.registerAgent({
      adapterKind: "dsh",
      projectId: "proj_alpha",
      card: { ...validCard("ag_dsh", "dsh"), capabilities: [{ capabilityId: "dsh.test", version: 1 }] },
    });
    assert.equal(reg.agentId, "ag_dsh");
    assert.equal(reg.projectId, "proj_alpha");

    const preview = await createPreview(store, {
      principalId: "local-operator",
      requestDigest: "dig_m_1",
      capabilityRevisionId: reg.capabilityRevisions[0].revisionId,
      workspaceId: "local",
      agentId: "ag_dsh",
    });
    const submitted = await methods.submitTask({
      previewId: preview.previewId,
      idempotencyKey: "idem_m_1",
      principalId: "local-operator",
      capabilityRevisionId: reg.capabilityRevisions[0].revisionId,
      workspaceId: "local",
      agentId: "ag_dsh",
      input: { prompt: "run dsh baseline" },
    });

    // Auto-wired `dsh` adapter dispatches cleanly without external adapter registration
    const disp = await methods.dispatchTask({ taskId: submitted.taskId });
    assert.equal(disp.status, "running");
    assert.deepEqual(disp.locator, { kind: "dsh", sessionId: "sess_1" });

    // Move task into waiting_approval with an open approval row
    const appRes = await engine.applyReport({
      taskId: submitted.taskId,
      attemptId: disp.attemptId,
      adapterEventId: "dsh:apr:1",
      report: {
        state: "waiting",
        attention: {
          kind: "approval",
          questionId: "apr_test_1",
          prompt: "Approve tool?",
        },
      },
    });
    assert.equal(appRes.status, "waiting_approval");

    // Reject non-allow/deny decision values
    await assert.rejects(
      () =>
        methods.decideApprovalTask({
          taskId: submitted.taskId,
          attemptId: disp.attemptId,
          approvalId: "apr_test_1",
          decision: "allow-once",
        }),
      (err) => isTaskError(err, TASK_ERROR.VALIDATION_FAILED),
    );

    // Valid allow decision via HTTP dispatcher -> maps to allow-once in engine
    const dispatchRpc = buildDispatcher(methods);
    const decided = await dispatchRpc("dsh.tasks.decideApproval", {
      taskId: submitted.taskId,
      attemptId: disp.attemptId,
      approvalId: "apr_test_1",
      decision: "allow",
      reason: "operator confirmed",
    });
    assert.equal(decided.decision, "allow-once");
    assert.equal(decided.status, "running");
    assert.ok(decided.operationId);

    // Deny decision also maps cleanly to reject
    const appRes2 = await engine.applyReport({
      taskId: submitted.taskId,
      attemptId: disp.attemptId,
      adapterEventId: "dsh:apr:2",
      report: {
        state: "waiting",
        attention: { kind: "approval", questionId: "apr_test_2", prompt: "Allow second tool?" },
      },
    });
    assert.equal(appRes2.status, "waiting_approval");
    const denied = await dispatchRpc("dsh.tasks.decideApproval", {
      taskId: submitted.taskId,
      attemptId: disp.attemptId,
      approvalId: "apr_test_2",
      decision: "deny",
      reason: "unsafe",
    });
    assert.equal(denied.decision, "reject");
    assert.ok(denied.operationId);

    // SEC-1.2: registerAgent rejects executable selection fields in adapterConfigRef
    for (const badRef of [
      JSON.stringify({ binary: "C:\\evil\\cmd.exe" }),
      JSON.stringify({ nested: { executable: "/tmp/pwn" } }),
      JSON.stringify({ command: "powershell" }),
      JSON.stringify({ argv: ["--bad"] }),
      { binary: "C:\\evil.exe" },
    ]) {
      await assert.rejects(
        () =>
          methods.registerAgent({
            adapterKind: "codex",
            card: validCard("ag_codex_bad", "codex"),
            adapterConfigRef: badRef,
          }),
        (err) =>
          isTaskError(err, TASK_ERROR.VALIDATION_FAILED) &&
          /tasksAdapters\.<kind>\.binary/.test(err.message),
      );
    }
  } finally {
    store.close();
  }
});
