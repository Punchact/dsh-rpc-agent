import assert from "node:assert/strict";
import test from "node:test";

import { capabilityRevisionId, hashCard, normalizeCard } from "../dist/lib/agents/card.mjs";
import { createMethods } from "../dist/lib/methods.mjs";
import { createTaskEngine, seedBaselineEntities } from "../dist/lib/tasks/engine.mjs";
import { openStore } from "../dist/lib/tasks/store.mjs";

type TestStore = ReturnType<typeof openStore>;
type TestEngine = ReturnType<typeof createTaskEngine>;

function req<T>(value: T | undefined, what = "item"): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}
interface SqliteDbLike {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
  };
}
type SeedEntitiesFn = (
  store: TestStore,
  opts: {
    principal?: { principalId: string; kind?: string };
    workspace?: { workspaceId: string; rootPath: string };
  },
) => Promise<unknown>;

interface CapabilityRevisionRow {
  revision_id: string;
  capability: string;
  side_effect_kind: string;
  cancel_policy: string;
}

const seedBaseline = seedBaselineEntities as unknown as SeedEntitiesFn;

function baseCard(overrides: Record<string, unknown> = {}) {
  return {
    identity: { agentId: "ag_1", name: "ag_1", kind: "dsh", version: "1.0.0" },
    controls: {
      start: { support: "required", evidence: "dsh" },
      steer: { support: "optional", evidence: "steer" },
      cancel: { support: "required", evidence: "cancel" },
      inspect: { support: "required", evidence: "status" },
      approval: { support: "required", evidence: "approvals" },
      events: { support: "required", evidence: "history" },
    },
    limitations: ["single-host"],
    ...overrides,
  };
}

function makeMethods(store: TestStore, engine: TestEngine) {
  return createMethods(
    {
      sessionController: {
        async create() {
          return { sessionId: "sess_1" };
        },
      },
      webServer: { getOrigin: () => "http://127.0.0.1:1" },
      taskStore: store as unknown as null,
      taskEngine: engine as unknown as null,
    },
    { tasksEnabled: true, tasksMaxConcurrent: 2 },
    { logger: { info() {}, warn() {}, error() {}, debug() {} }, get: () => undefined },
    {},
  );
}

test("a card with no capabilities normalises to an empty list", () => {
  const card = normalizeCard(baseCard());
  assert.deepEqual(card.capabilities, []);
});

test("declared capabilities are normalised with read-only defaults", () => {
  const card = normalizeCard(
    baseCard({
      capabilities: [
        { capabilityId: "review.diff", version: 1, schema: { type: "object" } },
        { capabilityId: "apply.fix", version: 2, sideEffectKind: "write" },
      ],
    }),
  );
  assert.deepEqual(card.capabilities[0], {
    capabilityId: "review.diff",
    version: 1,
    sideEffectKind: "read",
    cancelPolicy: "optional",
    schema: { type: "object" },
  });
  // §4.2 rule 4: a write capability must require cancellation.
  assert.equal(req(card.capabilities[1], "capabilities[1]").cancelPolicy, "required");
});

test("a write capability may not opt out of requiring cancellation", () => {
  assert.throws(
    () =>
      normalizeCard(
        baseCard({
          capabilities: [{ capabilityId: "apply.fix", sideEffectKind: "write", cancelPolicy: "optional" }],
        }),
      ),
    /writes side effects, so cancelPolicy must be "required"/,
  );
});

test("registering an agent publishes one immutable revision per declared capability", async () => {
  const store = openStore({ path: ":memory:" });
  const engine = createTaskEngine(store);
  try {
    await seedBaseline(store, {
      principal: { principalId: "local-operator" },
      workspace: { workspaceId: "local", rootPath: "C:\\work\\repo" },
    });
    const methods = makeMethods(store, engine);
    const card = baseCard({
      capabilities: [{ capabilityId: "review.diff", version: 1 }],
    });

    const first = await methods.registerAgent({ card });
    assert.equal(first.capabilityRevisions.length, 1);
    const revisionId = req(first.capabilityRevisions[0], "capabilityRevisions[0]").revisionId;
    assert.match(revisionId, /^cap_[0-9a-f]{24}$/);

    let rows = store.read((db: SqliteDbLike) => db.prepare("SELECT * FROM capability_revisions").all()) as CapabilityRevisionRow[];
    assert.equal(rows.length, 1);
    const row0 = req(rows[0], "rows[0]");
    assert.equal(row0.revision_id, revisionId);
    assert.equal(row0.capability, "review.diff");
    assert.equal(row0.side_effect_kind, "read");
    assert.equal(row0.cancel_policy, "optional");

    // Re-registering the unchanged card is idempotent: same revision, one row.
    const again = await methods.registerAgent({ card });
    assert.equal(req(again.capabilityRevisions[0], "capabilityRevisions[0]").revisionId, revisionId);
    rows = store.read((db: SqliteDbLike) => db.prepare("SELECT * FROM capability_revisions").all()) as CapabilityRevisionRow[];
    assert.equal(rows.length, 1);

    // agents.list exposes the revisions so a caller can discover what to submit.
    const listed = await methods.listAgents({});
    assert.equal(listed.items[0].capabilityRevisions[0].revisionId, revisionId);
  } finally {
    store.close();
  }
});

test("changing the card yields a different revision id for the same capability", () => {
  const cardA = normalizeCard(baseCard({ capabilities: [{ capabilityId: "review.diff" }] }));
  const cardB = normalizeCard(
    baseCard({ capabilities: [{ capabilityId: "review.diff" }], limitations: ["single-host", "no cancel"] }),
  );
  const revA = capabilityRevisionId(hashCard(cardA), "review.diff", 1);
  const revB = capabilityRevisionId(hashCard(cardB), "review.diff", 1);
  assert.notEqual(revA, revB);
  assert.equal(capabilityRevisionId(hashCard(cardA), "review.diff", 1), revA);
});
