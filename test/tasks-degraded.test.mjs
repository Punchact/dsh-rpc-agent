import assert from "node:assert/strict";
import test from "node:test";

import { createTaskEngine, degradedFromCapabilities, seedBaselineEntities } from "../lib/tasks/engine.mjs";
import { openStore } from "../lib/tasks/store.mjs";

// Plan §4.2 rule 4 (2026-11-18 "降级许可"): a control the agent declares
// optional-and-unsupported does not disqualify it, but the task detail must show the
// semantic consequence instead of silently pretending the control exists.
async function setup() {
  const store = openStore({ path: ":memory:" });
  await seedBaselineEntities(store, {
    principal: { principalId: "local-operator" },
    workspace: { workspaceId: "ws-lab", rootPath: "C:\\ws-lab" },
    agent: { agentId: "ag-degraded", adapterKind: "legacy", capabilities: { cancel: "unsupported", inspect: false } },
    capabilityRevision: { revisionId: "rev-review-1", capability: "review.diff@1" },
  });
  await seedBaselineEntities(store, {
    agent: { agentId: "ag-full", adapterKind: "dsh", capabilities: { cancel: "supported", inspect: "supported" } },
  });
  const engine = createTaskEngine(store);
  return { store, engine };
}

test("degradedFromCapabilities maps unsupported controls to their semantic effect", () => {
  const degraded = degradedFromCapabilities(JSON.stringify({ cancel: "unsupported", inspect: false, steer: "supported" }));
  assert.deepEqual(
    degraded.map((d) => d.control).sort(),
    ["cancel", "inspect"],
  );
  for (const entry of degraded) {
    assert.equal(typeof entry.effect, "string");
    assert.ok(entry.effect.length > 20, "effect must explain the consequence, not just the control name");
  }
  assert.deepEqual(degradedFromCapabilities("{}"), []);
  assert.deepEqual(degradedFromCapabilities(null), []);
});

test("task detail exposes degraded[] for an agent that cannot be cancelled", async () => {
  const { store, engine } = await setup();
  try {
    const task = await engine.submit({
      idempotencyKey: "k-degraded",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-degraded",
      input: { base: "a", head: "b" },
    });
    const detail = await engine.get({ taskId: task.taskId });
    assert.deepEqual(
      detail.degraded.map((d) => d.control).sort(),
      ["cancel", "inspect"],
    );
    assert.match(detail.degraded.find((d) => d.control === "cancel").effect, /needs_reconcile/);

    const full = await engine.submit({
      idempotencyKey: "k-full",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-full",
      input: { base: "a", head: "b" },
    });
    const fullDetail = await engine.get({ taskId: full.taskId });
    assert.deepEqual(fullDetail.degraded, [], "a fully capable agent must report no degraded controls");

    const listed = await engine.list({ limit: 10 });
    for (const row of listed.items) {
      assert.ok(Array.isArray(row.degraded), "list rows carry degraded[] too");
    }
  } finally {
    store.close();
  }
});
