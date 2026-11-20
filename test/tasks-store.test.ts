import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";

import {
  SCHEMA_VERSION,
  TABLE_NAMES,
  assertTableName,
  isTableName,
  openStore,
  primaryKeyForTable,
  rowToAgent,
  rowToApproval,
  rowToArtifact,
  rowToAttempt,
  rowToAttention,
  rowToCapabilityRevision,
  rowToEffect,
  rowToEvent,
  rowToInput,
  rowToMandate,
  rowToPreview,
  rowToPrincipal,
  rowToSchemaMeta,
  rowToTask,
  rowToWorkspace,
} from "../dist/lib/tasks/store.mjs";
import { isTaskError, TASK_ERROR } from "../dist/lib/tasks/errors.mjs";

const EXPECTED_TABLES = [
  "schema_meta",
  "principals",
  "workspaces",
  "agents",
  "capability_revisions",
  "previews",
  "tasks",
  "mandates",
  "attempts",
  "events",
  "effects",
  "inputs",
  "approvals",
  "artifacts",
  "attention",
];

test("openStore creates all §5.1 tables, enables WAL and foreign_keys, and writes schema_meta", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tasks-store-"));
  const dbPath = join(dir, "tasks.db");
  const store = openStore({ path: dbPath });
  try {
    const tables = store.read((db: DatabaseSync) =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((r) => (r as { name: string }).name),
    );
    for (const name of EXPECTED_TABLES) {
      assert.ok(tables.includes(name), `missing table: ${name}`);
    }

    const journal = store.read((db: DatabaseSync) => db.prepare("PRAGMA journal_mode").get()) as {
      journal_mode: string;
    };
    assert.equal(String(journal.journal_mode).toLowerCase(), "wal");

    const fk = store.read((db: DatabaseSync) => db.prepare("PRAGMA foreign_keys").get()) as {
      foreign_keys: number;
    };
    assert.equal(fk.foreign_keys, 1);

    const meta = store.read((db: DatabaseSync) => db.prepare("SELECT version FROM schema_meta LIMIT 1").get()) as {
      version: number;
    };
    assert.equal(meta.version, SCHEMA_VERSION);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("foreign_keys=ON rejects orphan tasks and readonly store refuses writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tasks-ro-"));
  const dbPath = join(dir, "tasks.db");
  const store = openStore({ path: dbPath });
  try {
    await assert.rejects(
      () =>
        store.withWriteTx((db: DatabaseSync) => {
          db.prepare(
            `INSERT INTO tasks (
               task_id, principal_id, idempotency_key, request_hash,
               capability_revision_id, workspace_id, agent_id, status, created_at, updated_at
             ) VALUES ('t1', 'missing-p', 'k1', 'h1', 'missing-c', 'missing-w', 'missing-a', 'queued', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
          ).run();
        }),
      /FOREIGN KEY constraint failed/i,
    );
  } finally {
    store.close();
  }

  const ro = openStore({ path: dbPath, readonly: true });
  try {
    const meta = ro.read((db: DatabaseSync) => db.prepare("SELECT version FROM schema_meta").get()) as {
      version: number;
    };
    assert.equal(meta.version, SCHEMA_VERSION);
    await assert.rejects(
      () => ro.withWriteTx(() => {}),
      (err) => isTaskError(err, TASK_ERROR.ACCESS_DENIED),
    );
  } finally {
    ro.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withWriteTx rolls back all changes when callback throws", async () => {
  const store = openStore({ path: ":memory:" });
  try {
    const now = new Date().toISOString();
    await assert.rejects(
      () =>
        store.withWriteTx((db: DatabaseSync) => {
          db.prepare(
            `INSERT INTO principals (principal_id, kind, scopes_json, created_at, updated_at)
             VALUES ('p-rollback', 'operator', '[]', ?, ?)`,
          ).run(now, now);
          throw new Error("boom inside tx");
        }),
      /boom inside tx/,
    );

    const row = store.read((db: DatabaseSync) =>
      db.prepare("SELECT * FROM principals WHERE principal_id = 'p-rollback'").get(),
    );
    assert.equal(row, undefined);
  } finally {
    store.close();
  }
});

test("withWriteTx retries on SQLITE_BUSY across concurrent connections and serializes per handle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tasks-busy-"));
  const dbPath = join(dir, "tasks.db");
  const storeA = openStore({ path: dbPath, busyTimeoutMs: 5, maxRetries: 20, retryDelayMs: 10 });
  const blocker = new DatabaseSync(dbPath);

  try {
    // Hold an external IMMEDIATE write lock briefly so storeA hits SQLITE_BUSY and retries.
    blocker.exec("PRAGMA busy_timeout = 5; BEGIN IMMEDIATE;");
    blocker
      .prepare(
        `INSERT INTO principals (principal_id, kind, scopes_json, created_at, updated_at)
         VALUES ('p-blocker', 'operator', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run();

    setTimeout(() => {
      blocker.exec("COMMIT;");
    }, 45);

    const res = await Promise.all([
      storeA.withWriteTx((db: DatabaseSync) => {
        db.prepare(
          `INSERT INTO principals (principal_id, kind, scopes_json, created_at, updated_at)
           VALUES ('p-1', 'operator', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        ).run();
        return "w1";
      }),
      storeA.withWriteTx((db: DatabaseSync) => {
        db.prepare(
          `INSERT INTO principals (principal_id, kind, scopes_json, created_at, updated_at)
           VALUES ('p-2', 'operator', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        ).run();
        return "w2";
      }),
    ]);

    assert.deepEqual(res, ["w1", "w2"]);
    const count = storeA.read((db: DatabaseSync) => db.prepare("SELECT COUNT(*) AS cnt FROM principals").get()) as {
      cnt: number;
    };
    assert.equal(count.cnt, 3);
  } finally {
    try {
      blocker.close();
    } catch {
      // already closed
    }
    storeA.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TABLE_NAMES covers all 15 tables, primaryKeyForTable matches SQLite schema, and assertTableName rejects invalid names", () => {
  const store = openStore({ path: ":memory:" });
  try {
    assert.equal(TABLE_NAMES.length, 15);
    assert.deepEqual([...TABLE_NAMES].sort(), [...EXPECTED_TABLES].sort());
    assert.ok(Object.isFrozen(TABLE_NAMES));

    for (const table of TABLE_NAMES) {
      assert.equal(isTableName(table), true);
      assert.equal(assertTableName(table), table);
      const pk = primaryKeyForTable(table);
      const cols = store.read((db: DatabaseSync) => db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{
        pk: number;
        name: string;
      }>;
      const pkCols = cols.filter((c) => c.pk === 1).map((c) => c.name);
      assert.deepEqual(pkCols, [pk], `primary key mismatch for table ${table}`);
    }

    for (const bad of ["nonexistent_table", "tasks; DROP TABLE tasks", "", "TASKS", null, undefined, 42]) {
      assert.equal(isTableName(bad), false);
      assert.throws(
        () => assertTableName(bad),
        (err) => isTaskError(err, TASK_ERROR.VALIDATION_FAILED),
      );
    }
  } finally {
    store.close();
  }
});

test("rowTo* mappers convert snake_case rows across all 15 tables to camelCase projections", async () => {
  const store = openStore({ path: ":memory:" });
  const now = "2026-11-19T12:00:00.000Z";
  try {
    await store.withWriteTx((db: DatabaseSync) => {
      db.prepare(
        `INSERT INTO principals (principal_id, kind, scopes_json, created_at, updated_at)
         VALUES ('p1', 'operator', '["task:submit"]', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO workspaces (workspace_id, root_path, allowed_side_effects_json, policy_json, created_at, updated_at)
         VALUES ('w1', 'C:/repo', '["read"]', '{"strict":true}', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO agents (agent_id, adapter_kind, adapter_config_ref, manifest_revision, capabilities_json, probe_status, enabled, updated_at)
         VALUES ('a1', 'dsh', '{"mode":"fast"}', 'rev-1', '{"cancel":"supported"}', 'verified', 1, ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO capability_revisions (revision_id, capability, version, schema_json, side_effect_kind, cancel_policy, limitations_json, created_at)
         VALUES ('c1', 'review.diff@1', '1', '{"type":"object"}', 'read', 'required', '["local"]', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO previews (preview_id, principal_id, normalized_request_json, candidates_json, selected_agent_id, selection_reason, policy_revision, capability_revision_id, expires_at, created_at)
         VALUES ('pv1', 'p1', '{"q":1}', '["a1"]', 'a1', 'best', 'v1', 'c1', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO tasks (task_id, principal_id, idempotency_key, request_hash, capability_revision_id, workspace_id, agent_id, preview_id, request_summary_json, status, state_version, result_json, result_valid, created_at, updated_at)
         VALUES ('t1', 'p1', 'ik1', 'rh1', 'c1', 'w1', 'a1', 'pv1', '{"title":"hi"}', 'succeeded', 2, '{"ok":true}', 1, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO mandates (mandate_id, principal_id, task_id, workspace_id, agent_id, allowed_ops_json, policy_revision, created_at)
         VALUES ('m1', 'p1', 't1', 'w1', 'a1', '["read"]', 'v1', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO attempts (attempt_id, task_id, attempt_no, agent_id, mandate_id, capability_revision_id, runtime_locator_json, status, side_effect_active, started_at, updated_at)
         VALUES ('att1', 't1', 1, 'a1', 'm1', 'c1', '{"sessionId":"s1"}', 'completed', 0, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO events (event_id, task_id, seq, attempt_id, type, source, payload_json, created_at)
         VALUES ('evt1', 't1', 1, 'att1', 'task.state.succeeded', 'engine', '{"from":"running"}', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO effects (operation_id, task_id, attempt_id, op_type, idempotency_key, request_summary_json, status, lease_expires_at, created_at, updated_at)
         VALUES ('eff1', 't1', 'att1', 'start', 'ek1', '{"x":1}', 'leased', ?, ?, ?)`,
      ).run(now, now, now);
      db.prepare(
        `INSERT INTO inputs (input_id, task_id, attempt_id, idempotency_key, text, delivery_status, created_at, updated_at)
         VALUES ('in1', 't1', 'att1', 'ink1', 'continue', 'delivered', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO approvals (approval_id, task_id, attempt_id, scope_json, summary, status, expires_at, created_at)
         VALUES ('ap1', 't1', 'att1', '{"op":"write"}', 'allow write?', 'pending', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO artifacts (artifact_id, task_id, attempt_id, kind, size_bytes, sha256, source_path, access_policy_json, created_at)
         VALUES ('art1', 't1', 'att1', 'diff', 128, 'abc', '/tmp/a.diff', '{"read":"principal"}', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO attention (question_id, task_id, attempt_id, kind, prompt, options_json, status, created_at)
         VALUES ('q1', 't1', 'att1', 'decision', 'pick one', '["A","B"]', 'open', ?)`,
      ).run(now);
    });

    const mapped = store.read((db: DatabaseSync) => ({
      meta: rowToSchemaMeta(db.prepare("SELECT * FROM schema_meta LIMIT 1").get()),
      principal: rowToPrincipal(db.prepare("SELECT * FROM principals WHERE principal_id = 'p1'").get()),
      workspace: rowToWorkspace(db.prepare("SELECT * FROM workspaces WHERE workspace_id = 'w1'").get()),
      agent: rowToAgent(db.prepare("SELECT * FROM agents WHERE agent_id = 'a1'").get()),
      capRev: rowToCapabilityRevision(db.prepare("SELECT * FROM capability_revisions WHERE revision_id = 'c1'").get()),
      preview: rowToPreview(db.prepare("SELECT * FROM previews WHERE preview_id = 'pv1'").get()),
      task: rowToTask(db.prepare("SELECT * FROM tasks WHERE task_id = 't1'").get()),
      mandate: rowToMandate(db.prepare("SELECT * FROM mandates WHERE mandate_id = 'm1'").get()),
      attempt: rowToAttempt(db.prepare("SELECT * FROM attempts WHERE attempt_id = 'att1'").get()),
      event: rowToEvent(db.prepare("SELECT * FROM events WHERE event_id = 'evt1'").get()),
      effect: rowToEffect(db.prepare("SELECT * FROM effects WHERE operation_id = 'eff1'").get()),
      input: rowToInput(db.prepare("SELECT * FROM inputs WHERE input_id = 'in1'").get()),
      approval: rowToApproval(db.prepare("SELECT * FROM approvals WHERE approval_id = 'ap1'").get()),
      artifact: rowToArtifact(db.prepare("SELECT * FROM artifacts WHERE artifact_id = 'art1'").get()),
      attention: rowToAttention(db.prepare("SELECT * FROM attention WHERE question_id = 'q1'").get()),
    }));

    assert.equal(mapped.meta.version, SCHEMA_VERSION);
    assert.deepEqual(mapped.principal.scopes, ["task:submit"]);
    assert.deepEqual(mapped.workspace.policy, { strict: true });
    assert.equal(mapped.agent.enabled, true);
    assert.deepEqual(mapped.agent.adapterConfig, { mode: "fast" });
    assert.deepEqual(mapped.capRev.limitations, ["local"]);
    assert.equal(mapped.preview.selectedAgentId, "a1");
    assert.equal(mapped.task.stateVersion, 2);
    assert.equal(mapped.task.resultValid, true);
    assert.deepEqual(mapped.task.result, { ok: true });
    assert.deepEqual(mapped.mandate.allowedOps, ["read"]);
    assert.equal(mapped.attempt.sideEffectActive, false);
    assert.deepEqual(mapped.attempt.runtimeLocator, { sessionId: "s1" });
    assert.deepEqual(mapped.event.payload, { from: "running" });
    assert.equal(mapped.effect.leaseExpiresAt, now);
    assert.equal(mapped.input.deliveryStatus, "delivered");
    assert.deepEqual(mapped.approval.scope, { op: "write" });
    assert.equal(mapped.artifact.sizeBytes, 128);
    assert.deepEqual(mapped.attention.options, ["A", "B"]);
  } finally {
    store.close();
  }
});
