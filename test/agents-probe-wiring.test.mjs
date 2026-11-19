// The probe runner only knows controls it is given. Adapters answer the whole control
// table in one read-only call, so the bridge from adapter to probe has to exist and has
// to be wired where the agent's adapter is known. Without it every card stays
// `unknown` forever, and a healthy executor looks unverifiable.

import assert from "node:assert/strict";
import test from "node:test";

import { probesFromAdapter } from "../dist/lib/agents/probe.mjs";
import { resolveConfig } from "../dist/lib/config.mjs";
import { buildDispatcher } from "../dist/lib/http.mjs";
import { createMethods } from "../dist/lib/methods.mjs";
import { createTaskEngine, seedBaselineEntities } from "../dist/lib/tasks/engine.mjs";
import { openStore } from "../dist/lib/tasks/store.mjs";

function card(agentId, kind = "antigravity") {
  return {
    cardVersion: "capability-card@1",
    identity: { agentId, name: "External executor", kind, version: "1.0.0" },
    capabilities: [{ capabilityId: "ag.execute", version: 1 }],
    controls: {
      start: { support: "required", evidence: "StartCascade" },
      steer: { support: "optional", evidence: "SendUserCascadeMessage" },
      cancel: { support: "optional", evidence: "ForceStopCascadeTree" },
      inspect: { support: "optional", evidence: "GetCascadeTrajectorySteps" },
      approval: { support: "unsupported", evidence: "no approval surface" },
      events: { support: "optional", evidence: "GetCascadeTrajectorySteps" },
    },
    limitations: ["drives a local executor"],
  };
}

async function setup({ adapters }) {
  const cfg = resolveConfig({ tasksEnabled: true });
  const store = openStore({ path: ":memory:" });
  await seedBaselineEntities(store, {
    principal: { principalId: "local-operator" },
    workspace: { workspaceId: "local", rootPath: "C:\\ws" },
    capabilityRevision: { revisionId: "cap-review-1", capability: "review.diff@1" },
  });
  const engine = createTaskEngine(store);
  const methods = createMethods(
    {
      sessionController: {},
      webServer: { getOrigin: () => "http://127.0.0.1:0" },
      taskStore: store,
      taskEngine: engine,
      adapters,
      // Exactly what index.mjs passes: the adapter the agent is assigned to.
      agentProbes: (row) => probesFromAdapter(adapters[row?.adapter_kind]),
    },
    cfg,
    { get: () => undefined },
    {},
  );
  return { store, dispatch: buildDispatcher(methods) };
}

test("a card registered for a live adapter can be verified by probing that adapter", async () => {
  const adapter = {
    async probe() {
      return {
        ok: true,
        controls: { start: true, steer: true, cancel: true, inspect: true, events: true, approval: false },
      };
    },
  };
  const { store, dispatch } = await setup({ adapters: { antigravity: adapter } });
  try {
    const reg = await dispatch("dsh.agents.register", { card: card("ag-live") });
    assert.equal(reg.probeStatus, "unverified");

    const probed = await dispatch("dsh.agents.probe", { agentId: "ag-live" });

    assert.notEqual(probed.probeStatus, "unknown", "a live adapter must not read as unknown");
    assert.equal(probed.probeStatus, "verified");
    assert.ok(probed.verifiedControls.includes("start"));
    assert.equal(probed.verified.start, true);
    // Declared unsupported, so it is never settled and never claimed verified.
    assert.equal(probed.card.controls.approval.verified, false);
    assert.equal(probed.card.verified, true);
  } finally {
    store.close();
  }
});

test("an agent whose adapter is not assembled stays unknown instead of inventing evidence", async () => {
  const { store, dispatch } = await setup({ adapters: { dsh: { probe: async () => ({ ok: true, controls: {} }) } } });
  try {
    await dispatch("dsh.agents.register", { card: card("ag-orphan", "codex") });
    const probed = await dispatch("dsh.agents.probe", { agentId: "ag-orphan" });

    assert.equal(probed.probeStatus, "unknown");
    assert.deepEqual(probed.verifiedControls, []);
    assert.ok(probed.unknown.length >= 4);
    assert.equal(probed.card.verified, false);
  } finally {
    store.close();
  }
});
