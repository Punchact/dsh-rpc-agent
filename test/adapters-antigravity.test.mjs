import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAntigravityAdapter, DEFAULT_ANTIGRAVITY_MODEL } from "../dist/lib/adapters/antigravity.mjs";
import { TASK_ERROR, isTaskError } from "../dist/lib/tasks/errors.mjs";

function makeFakeFetch(handlers) {
  const calls = [];
  const fetch = async (url, init) => {
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ url, method, headers: init.headers, body });
    const handler = handlers[method];
    const resp = handler ? await handler(body, init) : {};
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(resp);
      },
    };
  };
  return { fetch, calls };
}

test("antigravity adapter sends projectEnvConfig.projectId, flat items[].text, resolved MODEL_PLACEHOLDER_*, and ForceStopCascadeTree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ag-hub-"));
  writeFileSync(
    join(dir, "hub_4035.json"),
    JSON.stringify({ pid: process.pid, httpPort: 4035, httpsPort: 4034, lsVersion: "2.32.2", csrfToken: "csrf-test" }),
  );

  try {
    let currentSummary = { status: "CASCADE_RUN_STATUS_RUNNING", stepCount: 2 };
    const { fetch, calls } = makeFakeFetch({
      GetCascadeModelConfigData: () => ({
        clientModelConfigs: [
          { modelId: "gemini-4-hydrogen-high", modelOrAlias: { model: "MODEL_PLACEHOLDER_M777" } },
        ],
      }),
      StartCascade: (b) => ({ cascadeId: b.cascadeId }),
      SendUserCascadeMessage: () => ({}),
      GetAllCascadeTrajectories: () => ({
        trajectorySummaries: { [calls.find((c) => c.method === "StartCascade").body.cascadeId]: currentSummary },
      }),
      GetCascadeTrajectorySteps: () => ({
        steps: [
          { type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE" },
          { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", status: "CORTEX_STEP_STATUS_GENERATING" },
        ],
      }),
      ForceStopCascadeTree: (b) => ({ stoppedConversationIds: [b.conversationId] }),
    });

    const adapter = createAntigravityAdapter({
      fetch,
      daemonDir: dir,
      isPidAlive: () => true,
    });

    const started = await adapter.start({
      task: {
        taskId: "task-1",
        requestSummary: {
          projectId: "proj-abc",
          model: "gemini-4-hydrogen-high",
          prompt: "review diff",
        },
      },
      workspace: { rootPath: "C:\\Users\\Andy\\Documents\\Google Antigravity" },
      agent: { adapterConfig: {} },
    });

    assert.equal(started.accepted, true);
    assert.ok(!JSON.stringify(started).includes("csrf-test"), "csrfToken must never leak into locator");

    const startCall = calls.find((c) => c.method === "StartCascade");
    assert.equal(startCall.body.source, "CORTEX_TRAJECTORY_SOURCE_INTERACTIVE_CASCADE");
    assert.deepEqual(startCall.body.projectEnvConfig, { projectId: "proj-abc" });
    assert.equal(startCall.headers["X-Codeium-Csrf-Token"], "csrf-test");

    const sendCall = calls.find((c) => c.method === "SendUserCascadeMessage");
    assert.deepEqual(sendCall.body.items, [{ text: "review diff" }]);
    assert.equal(sendCall.body.items[0].chunk, undefined);
    assert.equal(sendCall.body.cascadeConfig.plannerConfig.requestedModel.model, "MODEL_PLACEHOLDER_M777");

    // Inspect status mappings
    const rProg = await adapter.inspect(started.locator);
    assert.equal(rProg.state, "progress");
    assert.equal(rProg.observedStatus, "CASCADE_RUN_STATUS_RUNNING");

    currentSummary = { status: "CASCADE_RUN_STATUS_IDLE", stepCount: 3 };
    const rReady = await adapter.inspect(started.locator);
    assert.equal(rReady.state, "ready");
    assert.equal(rReady.observedStatus, "CASCADE_RUN_STATUS_IDLE");

    currentSummary = {
      status: "CASCADE_RUN_STATUS_IDLE",
      stepCount: 3,
      latestExecutorTerminationReason: "EXECUTOR_TERMINATION_REASON_USER_CANCELED",
    };
    const rDropped = await adapter.inspect(started.locator);
    assert.equal(rDropped.state, "dropped");
    assert.equal(rDropped.droppedBy, "cancelled");

    currentSummary = { status: "CASCADE_RUN_STATUS_ERROR", stepCount: 3 };
    const rFailed = await adapter.inspect(started.locator);
    assert.equal(rFailed.state, "failed");

    currentSummary = { status: "CASCADE_RUN_STATUS_WEIRD" };
    const rBlocked = await adapter.inspect(started.locator);
    assert.equal(rBlocked.state, "blocked");
    assert.equal(rBlocked.observedStatus, "CASCADE_RUN_STATUS_WEIRD");

    // Cancel uses ForceStopCascadeTree, never CancelCascadeSteps
    const cancelled = await adapter.cancel(started.locator);
    assert.equal(cancelled.requestAccepted, true);
    assert.ok(calls.some((c) => c.method === "ForceStopCascadeTree"));
    assert.ok(!calls.some((c) => c.method === "CancelCascadeSteps"));

    // Fallback model warning when modelId is unrecognized
    const fallbackStart = await adapter.start({
      task: { taskId: "task-2", requestSummary: { model: "nonexistent-model", prompt: "hi" } },
      workspace: { rootPath: "C:\\ws" },
    });
    assert.equal(fallbackStart.locator.model, DEFAULT_ANTIGRAVITY_MODEL);
    assert.match(fallbackStart.warning, /MODEL_PLACEHOLDER_M525/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("antigravity adapter fails with ADAPTER_UNAVAILABLE when no alive hub descriptor exists", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "ag-empty-"));
  try {
    const { fetch } = makeFakeFetch({});
    const adapter = createAntigravityAdapter({ fetch, daemonDir: emptyDir });
    await assert.rejects(
      () => adapter.start({ task: { requestSummary: { prompt: "x" } } }),
      (err) => isTaskError(err, TASK_ERROR.ADAPTER_UNAVAILABLE) && err.data?.reason === "no_alive_hub",
    );

    const missingAdapter = createAntigravityAdapter({
      fetch,
      daemonDir: join(emptyDir, "does-not-exist"),
    });
    await assert.rejects(
      () => missingAdapter.start({ task: { requestSummary: { prompt: "x" } } }),
      (err) => isTaskError(err, TASK_ERROR.ADAPTER_UNAVAILABLE) && err.data?.reason === "daemon_dir_unreadable",
    );
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("antigravity adapter enforces redirect:error, timeout signal, response size cap, and sanitized messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ag-sec-"));
  writeFileSync(
    join(dir, "hub_4035.json"),
    JSON.stringify({ pid: process.pid, httpPort: 4035, lsVersion: "2.32.2", csrfToken: "csrf-secret" }),
  );
  try {
    let seenInit = null;
    const hugeAdapter = createAntigravityAdapter({
      daemonDir: dir,
      isPidAlive: () => true,
      maxResponseChars: 128,
      timeoutMs: 2_000,
      fetch: async (_url, init) => {
        seenInit = init;
        return {
          ok: true,
          status: 200,
          async text() {
            return "x".repeat(256);
          },
        };
      },
    });
    await assert.rejects(
      () => hugeAdapter.start({ task: { requestSummary: { prompt: "hi" } } }),
      (err) =>
        isTaskError(err, TASK_ERROR.ADAPTER_UNAVAILABLE) &&
        err.data?.reason === "response_too_large" &&
        !err.message.includes("4035") &&
        !err.message.includes("csrf-secret"),
    );
    assert.equal(seenInit.redirect, "error");
    assert.ok(seenInit.signal);

    const bodyErrAdapter = createAntigravityAdapter({
      daemonDir: dir,
      isPidAlive: () => true,
      fetch: async () => ({
        ok: true,
        status: 200,
        async text() {
          throw new Error("stream broken at http://127.0.0.1:4035/leak");
        },
      }),
    });
    await assert.rejects(
      () => bodyErrAdapter.start({ task: { requestSummary: { prompt: "hi" } } }),
      (err) =>
        isTaskError(err, TASK_ERROR.ADAPTER_UNAVAILABLE) &&
        err.data?.reason === "body_read_error" &&
        !err.message.includes("4035") &&
        !err.message.includes("leak"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
