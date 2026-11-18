import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";

import { SCHEMA_VERSION, openStore } from "../lib/tasks/store.mjs";
import { isTaskError, TASK_ERROR } from "../lib/tasks/errors.mjs";

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
    const tables = store.read((db) =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((r) => r.name),
    );
    for (const name of EXPECTED_TABLES) {
      assert.ok(tables.includes(name), `missing table: ${name}`);
    }

    const journal = store.read((db) => db.prepare("PRAGMA journal_mode").get());
    assert.equal(String(journal.journal_mode).toLowerCase(), "wal");

    const fk = store.read((db) => db.prepare("PRAGMA foreign_keys").get());
    assert.equal(fk.foreign_keys, 1);

    const meta = store.read((db) => db.prepare("SELECT version FROM schema_meta LIMIT 1").get());
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
        store.withWriteTx((db) => {
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
    const meta = ro.read((db) => db.prepare("SELECT version FROM schema_meta").get());
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
        store.withWriteTx((db) => {
          db.prepare(
            `INSERT INTO principals (principal_id, kind, scopes_json, created_at, updated_at)
             VALUES ('p-rollback', 'operator', '[]', ?, ?)`,
          ).run(now, now);
          throw new Error("boom inside tx");
        }),
      /boom inside tx/,
    );

    const row = store.read((db) =>
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
      storeA.withWriteTx((db) => {
        db.prepare(
          `INSERT INTO principals (principal_id, kind, scopes_json, created_at, updated_at)
           VALUES ('p-1', 'operator', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        ).run();
        return "w1";
      }),
      storeA.withWriteTx((db) => {
        db.prepare(
          `INSERT INTO principals (principal_id, kind, scopes_json, created_at, updated_at)
           VALUES ('p-2', 'operator', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        ).run();
        return "w2";
      }),
    ]);

    assert.deepEqual(res, ["w1", "w2"]);
    const count = storeA.read((db) => db.prepare("SELECT COUNT(*) AS cnt FROM principals").get());
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
