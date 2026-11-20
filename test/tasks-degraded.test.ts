import assert from "node:assert/strict";
import test from "node:test";

import { createTaskEngine, degradedFromCapabilities, seedBaselineEntities } from "../dist/lib/tasks/engine.mjs";
import { openStore } from "../dist/lib/tasks/store.mjs";

const seedBaseline = seedBaselineEntities as unknown as (
  store: unknown,
  seed: Record<string, unknown>,
) => Promise<void>;

// Plan §4.2 rule 4 (2026-11-18 "降级许可"): a control the agent declares
// optional-and-unsupported does not disqualify it, but the task detail must show the
// semantic consequence instead of silently pretending the control exists.
async function setup() {
  const store = openStore({ path: ":memory:" });
  await seedBaseline(store, {
    principal: { principalId: "local-operator" },
    workspace: { workspaceId: "ws-lab", rootPath: "C:\\ws-lab" },
    agent: { agentId: "ag-degraded", adapterKind: "legacy", capabilities: { cancel: "unsupported", inspect: false } },
    capabilityRevision: { revisionId: "rev-review-1", capability: "review.diff@1" },
  });
  await seedBaseline(store, {
    agent: { agentId: "ag-full", adapterKind: "dsh", capabilities: { cancel: "supported", inspect: "supported" } },
  });
  const engine = createTaskEngine(store);
  return { store, engine };
}

test("degradedFromCapabilities maps unsupported controls to their semantic effect", () => {
  // Hand-written/flat rows stay readable, but the authoritative shape is the card
  // stored by dsh.agents.register (`controls.<name>.support`); see the next test.
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
    const detail = (await engine.get({ taskId: task.taskId })) as {
      degraded: Array<{ control: string; effect: string }>;
    };
    assert.deepEqual(
      detail.degraded.map((d) => d.control).sort(),
      ["cancel", "inspect"],
    );
    assert.match(detail.degraded.find((d) => d.control === "cancel")!.effect, /needs_reconcile/);

    const full = await engine.submit({
      idempotencyKey: "k-full",
      capabilityRevisionId: "rev-review-1",
      workspaceId: "ws-lab",
      agentId: "ag-full",
      input: { base: "a", head: "b" },
    });
    const fullDetail = (await engine.get({ taskId: full.taskId })) as {
      degraded: Array<{ control: string; effect: string }>;
    };
    assert.deepEqual(fullDetail.degraded, [], "a fully capable agent must report no degraded controls");

    const listed = (await engine.list({ limit: 10 })) as { items: Array<{ degraded: unknown }> };
    for (const row of listed.items) {
      assert.ok(Array.isArray(row.degraded), "list rows carry degraded[] too");
    }
  } finally {
    store.close();
  }
});

test("degradedFromCapabilities reads the capability-card shape that registerAgent stores", () => {
  // Exactly what lib/methods.mjs writes: the normalized card plus a legacy flat
  // `cancel`. Reading only the flat field used to report 1 of 6 controls (t4 D2).
  const card = {
    cardVersion: "capability-card@1",
    identity: { agentId: "ag-card", kind: "dsh", version: "1" },
    capabilities: ["review.diff@1"],
    limitations: ["no native approval path"],
    controls: {
      start: { support: "required", evidence: "probe" },
      steer: { support: "unsupported", evidence: "probe" },
      cancel: { support: "unsupported", evidence: "probe" },
      inspect: { support: "optional", evidence: "probe" },
      events: { support: "unsupported", evidence: "probe" },
      approval: { support: "unsupported", evidence: "probe" },
    },
    cancel: "unsupported",
  };
  const degraded = degradedFromCapabilities(JSON.stringify(card));
  assert.deepEqual(
    degraded.map((d) => d.control).sort(),
    ["approval", "cancel", "events", "steer"],
    "every unsupported control in the card must surface, not just the flat cancel field",
  );
  for (const entry of degraded) {
    assert.ok(entry.effect.length > 20, "each control keeps a readable consequence");
  }

  // A card declaring everything required/optional degrades nothing.
  const healthy = {
    cardVersion: "capability-card@1",
    controls: {
      start: { support: "required" },
      steer: { support: "optional" },
      cancel: { support: "required" },
      inspect: { support: "optional" },
      events: { support: "required" },
      approval: { support: "optional" },
    },
  };
  assert.deepEqual(degradedFromCapabilities(JSON.stringify(healthy)), []);
});

test("a seeded capability card keeps degraded[] visible on the detail path", async () => {
  const store = openStore({ path: ":memory:" });
  try {
    await seedBaseline(store, {
      principal: { principalId: "local-operator" },
      workspace: { workspaceId: "ws-card", rootPath: "C:\\ws-card" },
      capabilityRevision: { revisionId: "rev-card", capability: "review.diff@1" },
      agent: {
        agentId: "ag-card-e2e",
        adapterKind: "dsh",
        capabilities: {
          cardVersion: "capability-card@1",
          controls: {
            start: { support: "required" },
            steer: { support: "unsupported" },
            cancel: { support: "unsupported" },
            inspect: { support: "unsupported" },
            events: { support: "unsupported" },
            approval: { support: "unsupported" },
          },
          cancel: "unsupported",
        },
      },
    });
    const engine = createTaskEngine(store);
    const task = await engine.submit({
      idempotencyKey: "k-card-e2e",
      capabilityRevisionId: "rev-card",
      workspaceId: "ws-card",
      agentId: "ag-card-e2e",
      input: { base: "a", head: "b" },
    });
    const detail = (await engine.get({ taskId: task.taskId })) as {
      degraded: Array<{ control: string; effect: string }>;
    };
    assert.deepEqual(
      detail.degraded.map((d) => d.control).sort(),
      ["approval", "cancel", "events", "inspect", "steer"],
    );
  } finally {
    store.close();
  }
});
