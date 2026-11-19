import assert from "node:assert/strict";
import test from "node:test";

import { createMethods } from "../lib/methods.mjs";
import { createTaskEngine, seedBaselineEntities } from "../lib/tasks/engine.mjs";
import { openStore } from "../lib/tasks/store.mjs";

function card(agentId, extra = {}) {
  return {
    identity: { agentId, name: agentId, kind: "dsh", version: "1.0.0" },
    capabilities: [{ capabilityId: "review.diff", version: 1 }],
    controls: {
      start: { support: "required", evidence: "dsh" },
      steer: { support: "optional", evidence: "steer" },
      cancel: { support: "required", evidence: "cancel" },
      inspect: { support: "required", evidence: "status" },
      approval: { support: "required", evidence: "approvals" },
      events: { support: "required", evidence: "history" },
    },
    limitations: ["single-host"],
    ...extra,
  };
}

async function makeWorld() {
  const store = openStore({ path: ":memory:" });
  const engine = createTaskEngine(store);
  await seedBaselineEntities(store, {
    principal: { principalId: "local-operator" },
    workspace: { workspaceId: "local", rootPath: "C:\\work\\repo" },
  });
  const methods = createMethods(
    {
      sessionController: { async create() { return { sessionId: "sess_1" }; } },
      webServer: { getOrigin: () => "http://127.0.0.1:1" },
      taskStore: store,
      taskEngine: engine,
    },
    { tasksEnabled: true, tasksMaxConcurrent: 2 },
    { logger: { info() {}, warn() {}, error() {}, debug() {} }, get: () => undefined },
    {},
  );
  return { store, engine, methods };
}

test("dsh.tasks.events reads a task's own log and validates its cursor window", async () => {
  const { store, methods } = await makeWorld();
  try {
    const reg = await methods.registerAgent({ card: card("ag_events") });
    const revisionId = reg.capabilityRevisions[0].revisionId;
    const preview = await methods.previewTask({
      principalId: "local-operator",
      capabilityRevisionId: revisionId,
      workspaceId: "local",
      agentId: "ag_events",
      input: { prompt: "hi" },
    });
    const submitted = await methods.submitTask({
      previewId: preview.previewId,
      idempotencyKey: "ev-1",
    });

    const events = await methods.taskEvents({ taskId: submitted.taskId });
    assert.equal(events.taskId, submitted.taskId);
    assert.ok(events.events.length >= 1);
    assert.equal(events.events[0].type, "task.accepted");
    assert.equal(events.events[0].seq, 1);
    assert.equal(events.hasMore, false);

    await assert.rejects(() => methods.taskEvents({ taskId: submitted.taskId, limit: 0 }), /limit/);
    await assert.rejects(() => methods.taskEvents({ taskId: "task_missing" }), /task not found/);
  } finally {
    store.close();
  }
});

test("preview refuses a capability revision the selected agent never declared", async () => {
  const { store, methods } = await makeWorld();
  try {
    const a = await methods.registerAgent({ card: card("ag_a") });
    await methods.registerAgent({ card: card("ag_b") });
    const revisionOfA = a.capabilityRevisions[0].revisionId;

    await assert.rejects(
      () =>
        methods.previewTask({
          capabilityRevisionId: revisionOfA,
          principalId: "local-operator",
          workspaceId: "local",
          agentId: "ag_b",
          input: { prompt: "hi" },
        }),
      (err) => {
        assert.match(err.message, /does not declare capability revision/);
        assert.equal(err.data?.reason, "CAPABILITY_VERSION_MISSING");
        return true;
      },
    );
  } finally {
    store.close();
  }
});

test("preview refuses an agent whose probe evidence has expired", async () => {
  const { store, methods } = await makeWorld();
  try {
    const a = await methods.registerAgent({ card: card("ag_stale") });
    const revisionId = a.capabilityRevisions[0].revisionId;
    await store.withWriteTx((db) => {
      db.prepare("UPDATE agents SET probe_expires_at = ? WHERE agent_id = ?").run(
        new Date(Date.now() - 60_000).toISOString(),
        "ag_stale",
      );
    });

    await assert.rejects(
      () =>
        methods.previewTask({
          capabilityRevisionId: revisionId,
          principalId: "local-operator",
          workspaceId: "local",
          agentId: "ag_stale",
          input: { prompt: "hi" },
        }),
      (err) => {
        assert.match(err.message, /expired/);
        assert.equal(err.data?.reason, "PROBE_STALE");
        return true;
      },
    );
  } finally {
    store.close();
  }
});

test("preview reports why a peer that declares the same capability was excluded", async () => {
  const { store, methods } = await makeWorld();
  try {
    const chosen = await methods.registerAgent({ card: card("ag_chosen") });
    await methods.registerAgent({ card: card("ag_disabled"), enabled: false });
    const revisionId = chosen.capabilityRevisions[0].revisionId;

    const preview = await methods.previewTask({
      principalId: "local-operator",
      capabilityRevisionId: revisionId,
      workspaceId: "local",
      agentId: "ag_chosen",
      input: { prompt: "hi" },
    });
    const selected = preview.candidates.find((item) => item.agentId === "ag_chosen");
    const excluded = preview.candidates.find((item) => item.agentId === "ag_disabled");
    assert.equal(selected.included, true);
    assert.equal(selected.reason, "SELECTED");
    assert.equal(excluded.included, false);
    assert.equal(excluded.reason, "AGENT_DISABLED");
    assert.equal(preview.selectionReason, "selected");
  } finally {
    store.close();
  }
});