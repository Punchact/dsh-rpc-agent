import assert from "node:assert/strict";
import test from "node:test";

import { isTaskError } from "../dist/lib/tasks/errors.mjs";
import { createMethods } from "../dist/lib/methods.mjs";
import { createTaskEngine, seedBaselineEntities } from "../dist/lib/tasks/engine.mjs";
import { openStore } from "../dist/lib/tasks/store.mjs";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

type TestStore = ReturnType<typeof openStore>;
type SeedEntitiesFn = (
  store: TestStore,
  opts: {
    principal?: { principalId: string; kind?: string };
    workspace?: { workspaceId: string; rootPath: string };
  },
) => Promise<unknown>;
const seedBaseline = seedBaselineEntities as unknown as SeedEntitiesFn;

function cardOf(agentId: string) {
  return {
    identity: { agentId, name: `${agentId} display`, kind: "dsh", version: "1.0.0" },
    capabilities: [
      { capabilityId: "review.diff", version: 1, sideEffectKind: "read" },
      { capabilityId: "code.patch", version: 2, sideEffectKind: "write", cancelPolicy: "required" },
    ],
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

async function makeWorld() {
  const store = openStore({ path: ":memory:" });
  await seedBaseline(store, {
    principal: { principalId: "local-operator" },
    workspace: { workspaceId: "local", rootPath: "C:\\work\\repo" },
  });
  const engine = createTaskEngine(store);
  const methods = createMethods(
    {
      sessionController: { async create() { return { sessionId: "sess_1" }; } },
      webServer: { getOrigin: () => "http://127.0.0.1:1" },
      taskStore: store as unknown as null,
      taskEngine: engine as unknown as null,
    },
    { tasksEnabled: true, tasksMaxConcurrent: 2 },
    { logger: silentLogger, get: () => undefined },
    {},
  );
  return { store, engine, methods };
}

test("agents.get returns the published card and its capability revisions", async () => {
  const { methods } = await makeWorld();
  const registered = await methods.registerAgent({ card: cardOf("ag-visible") });
  assert.equal(registered.capabilityRevisions.length, 2);

  const agent = await methods.getAgent({ agentId: "ag-visible" });
  assert.equal(agent.agentId, "ag-visible");
  assert.equal(agent.adapterKind, "dsh");
  assert.equal(agent.enabled, true);
  assert.equal(agent.card.identity.agentId, "ag-visible");
  assert.equal(agent.capabilityRevisions.length, 2);
  const ids = agent.capabilityRevisions.map((revision: { capability: string }) => revision.capability).sort();
  assert.deepEqual(ids, ["code.patch", "review.diff"]);
  for (const revision of agent.capabilityRevisions) {
    assert.match(revision.revisionId, /^cap_[0-9a-f]{24}$/);
    assert.ok(revision.version !== undefined && revision.version !== null, "revision must carry a version");
  }
});

test("agents.get refuses a blank id and reports an unknown agent as not found", async () => {
  const { methods } = await makeWorld();

  await assert.rejects(() => methods.getAgent({ agentId: "   " }), (error: Error) => {
    assert.ok(isTaskError(error), "expected a task error");
    assert.match(error.message, /agentId|required/i);
    return true;
  });

  await assert.rejects(() => methods.getAgent({ agentId: "ag-ghost" }), (error: Error) => {
    assert.ok(isTaskError(error), "expected a task error");
    assert.match(error.message, /not found/i);
    return true;
  });
});
