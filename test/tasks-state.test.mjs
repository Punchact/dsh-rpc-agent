import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { TASK_ERROR, isTaskError } from "../lib/tasks/errors.mjs";
import { seedBaselineEntities } from "../lib/tasks/engine.mjs";
import {
  ALLOWED_TRANSITIONS,
  TASK_STATES,
  TERMINAL_STATES,
  appendEvent,
  canTransition,
  transition,
} from "../lib/tasks/state-machine.mjs";
import { openStore } from "../lib/tasks/store.mjs";

async function createSeededStoreWithTask(initialStatus = "queued") {
  const store = openStore({ path: ":memory:" });
  await seedBaselineEntities(store, {
    principal: { principalId: "p-1" },
    workspace: { workspaceId: "ws-1", rootPath: "C:\\ws" },
    agent: { agentId: "ag-1", adapterKind: "dsh" },
    capabilityRevision: { revisionId: "cap-1", capability: "review.diff@1" },
  });
  const taskId = `task_${randomUUID()}`;
  const now = new Date().toISOString();
  await store.withWriteTx((db) => {
    db.prepare(
      `INSERT INTO tasks (
         task_id, principal_id, idempotency_key, request_hash,
         capability_revision_id, workspace_id, agent_id, status, state_version,
         created_at, updated_at
       ) VALUES (?, 'p-1', ?, 'hash', 'cap-1', 'ws-1', 'ag-1', ?, 1, ?, ?)`,
    ).run(taskId, `idem_${randomUUID()}`, initialStatus, now, now);
  });
  return { store, taskId };
}

test("ALLOWED_TRANSITIONS is frozen and matches all 11 states", () => {
  assert.equal(TASK_STATES.length, 11);
  assert.ok(Object.isFrozen(ALLOWED_TRANSITIONS));
  for (const state of TASK_STATES) {
    assert.ok(Array.isArray(ALLOWED_TRANSITIONS[state]));
    assert.ok(Object.isFrozen(ALLOWED_TRANSITIONS[state]));
  }
  for (const terminal of TERMINAL_STATES) {
    assert.deepEqual(ALLOWED_TRANSITIONS[terminal], []);
  }
});

test("every legal transition succeeds, increments state_version, and records an event", async () => {
  for (const from of TASK_STATES) {
    for (const to of ALLOWED_TRANSITIONS[from]) {
      assert.equal(canTransition(from, to), true);
      const { store, taskId } = await createSeededStoreWithTask(from);
      try {
        const res = await transition(store, {
          taskId,
          expectedStateVersion: 1,
          to,
          reason: `test ${from} -> ${to}`,
        });
        assert.equal(res.from, from);
        assert.equal(res.to, to);
        assert.equal(res.stateVersion, 2);
        assert.equal(res.event.seq, 1);

        const row = store.read((db) => db.prepare("SELECT status, state_version FROM tasks WHERE task_id = ?").get(taskId));
        assert.equal(row.status, to);
        assert.equal(row.state_version, 2);
      } finally {
        store.close();
      }
    }
  }
});

test("illegal transitions reject with STATE_CONFLICT", async () => {
  const illegalPairs = [
    ["queued", "running"],
    ["queued", "succeeded"],
    ["queued", "review_pending"],
    ["dispatching", "waiting_input"],
    ["running", "queued"],
    ["running", "succeeded"],
    ["cancel_requested", "running"],
    ["cancel_requested", "waiting_approval"],
    ["review_pending", "running"],
  ];

  for (const [from, to] of illegalPairs) {
    assert.equal(canTransition(from, to), false);
    const { store, taskId } = await createSeededStoreWithTask(from);
    try {
      await assert.rejects(
        () => transition(store, { taskId, expectedStateVersion: 1, to }),
        (err) => isTaskError(err, TASK_ERROR.STATE_CONFLICT),
      );
      const row = store.read((db) => db.prepare("SELECT status, state_version FROM tasks WHERE task_id = ?").get(taskId));
      assert.equal(row.status, from);
      assert.equal(row.state_version, 1);
    } finally {
      store.close();
    }
  }
});

test("optimistic lock rejects stale expectedStateVersion with STATE_CONFLICT", async () => {
  const { store, taskId } = await createSeededStoreWithTask("queued");
  try {
    await transition(store, { taskId, expectedStateVersion: 1, to: "dispatching" });
    await assert.rejects(
      () => transition(store, { taskId, expectedStateVersion: 1, to: "running" }),
      (err) => isTaskError(err, TASK_ERROR.STATE_CONFLICT) && err.data?.actualStateVersion === 2,
    );
  } finally {
    store.close();
  }
});

test("terminal states reject all transitions and only allow appending events", async () => {
  for (const terminal of TERMINAL_STATES) {
    const { store, taskId } = await createSeededStoreWithTask(terminal);
    try {
      for (const target of TASK_STATES) {
        await assert.rejects(
          () => transition(store, { taskId, expectedStateVersion: 1, to: target }),
          (err) => isTaskError(err, TASK_ERROR.STATE_CONFLICT),
        );
      }

      const evt = await appendEvent(store, {
        taskId,
        type: "report.late",
        source: "adapter",
        payload: { note: "arrived after terminal" },
      });
      assert.equal(evt.seq, 1);

      const row = store.read((db) => db.prepare("SELECT status, state_version FROM tasks WHERE task_id = ?").get(taskId));
      assert.equal(row.status, terminal);
      assert.equal(row.state_version, 1);
    } finally {
      store.close();
    }
  }
});
