// Durable SQLite store for the DSH local agent task center (§5.1).
//
// Uses Node's built-in `node:sqlite` (`DatabaseSync`, Node >=22.13 / >=24) so
// the plugin keeps zero runtime dependencies. Every write transaction uses
// `BEGIN IMMEDIATE` with bounded busy retry and per-handle serialization.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { TASK_ERROR, taskError, validationFailed } from "./errors.mjs";

export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER PRIMARY KEY,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS principals (
  principal_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  credential_hash TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  allowed_side_effects_json TEXT NOT NULL DEFAULT '[]',
  policy_json TEXT NOT NULL DEFAULT '{}',
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  adapter_kind TEXT NOT NULL,
  adapter_config_ref TEXT NOT NULL DEFAULT '',
  manifest_revision TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  probe_status TEXT NOT NULL DEFAULT 'unknown',
  probe_evidence_json TEXT,
  probe_expires_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capability_revisions (
  revision_id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  version TEXT NOT NULL,
  schema_json TEXT NOT NULL DEFAULT '{}',
  side_effect_kind TEXT NOT NULL DEFAULT 'read',
  cancel_policy TEXT NOT NULL DEFAULT 'required',
  limitations_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS previews (
  preview_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  normalized_request_json TEXT NOT NULL,
  candidates_json TEXT NOT NULL DEFAULT '[]',
  selected_agent_id TEXT REFERENCES agents(agent_id),
  selection_reason TEXT,
  policy_revision TEXT,
  capability_revision_id TEXT REFERENCES capability_revisions(revision_id),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  capability_revision_id TEXT NOT NULL REFERENCES capability_revisions(revision_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  preview_id TEXT REFERENCES previews(preview_id),
  request_summary_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 1,
  active_attempt_id TEXT,
  cancel_requested_at TEXT,
  cancel_reason TEXT,
  source_task_id TEXT REFERENCES tasks(task_id),
  result_json TEXT,
  result_valid INTEGER,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(principal_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at, task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_principal ON tasks(principal_id, updated_at, task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id, updated_at, task_id);

CREATE TABLE IF NOT EXISTS mandates (
  mandate_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  allowed_ops_json TEXT NOT NULL DEFAULT '[]',
  policy_revision TEXT NOT NULL DEFAULT 'v1',
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_no INTEGER NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  mandate_id TEXT REFERENCES mandates(mandate_id),
  capability_revision_id TEXT NOT NULL REFERENCES capability_revisions(revision_id),
  runtime_locator_json TEXT,
  status TEXT NOT NULL,
  failure_class TEXT,
  side_effect_active INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(task_id, attempt_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_one_active
  ON attempts(task_id)
  WHERE side_effect_active = 1;

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  seq INTEGER NOT NULL,
  attempt_id TEXT REFERENCES attempts(attempt_id),
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  adapter_event_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_adapter_dedup
  ON events(task_id, attempt_id, adapter_event_id)
  WHERE adapter_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS effects (
  operation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT REFERENCES attempts(attempt_id),
  op_type TEXT NOT NULL,
  idempotency_key TEXT,
  request_summary_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  lease_expires_at TEXT,
  receipt_json TEXT,
  reconcile_result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_effects_task_op_idem
  ON effects(task_id, op_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS inputs (
  input_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  question_id TEXT,
  idempotency_key TEXT NOT NULL,
  text TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  scope_json TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  decision TEXT,
  decided_by TEXT,
  decision_note TEXT,
  idempotency_key TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT REFERENCES attempts(attempt_id),
  kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  source_path TEXT,
  access_policy_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attention (
  question_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT REFERENCES attempts(attempt_id),
  kind TEXT NOT NULL CHECK(kind IN ('decision', 'input', 'approval', 'review')),
  prompt TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  expires_at TEXT,
  resolved_by TEXT,
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_attention_task_status ON attention(task_id, status);
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isSqliteBusyError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.errcode === 5 || error.errcode === 6) return true;
  const msg = String(error.message ?? "");
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED|database table is locked/i.test(msg);
}

/**
 * Open a SQLite task store.
 *
 * @param {object} [options]
 * @param {string} [options.path=":memory:"] SQLite file path or ":memory:"
 * @param {boolean} [options.readonly=false] Open in read-only mode
 * @param {number} [options.busyTimeoutMs=200] SQLite busy_timeout pragma (ms)
 * @param {number} [options.maxRetries=12] Max retries on SQLITE_BUSY during BEGIN IMMEDIATE
 * @param {number} [options.retryDelayMs=10] Base backoff (ms) between SQLITE_BUSY retries
 */
export function openStore({
  path = ":memory:",
  readonly = false,
  busyTimeoutMs = 200,
  maxRetries = 12,
  retryDelayMs = 10,
} = {}) {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw validationFailed("`path` must be a non-empty string or ':memory:'");
  }
  const dbPath = path.trim();
  if (!readonly && dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath, { readOnly: Boolean(readonly) });
  let closed = false;
  let txChain = Promise.resolve();

  const ensureOpen = () => {
    if (closed) throw taskError(TASK_ERROR.STATE_CONFLICT, "task store is closed");
  };

  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))};`);
    db.exec("PRAGMA foreign_keys = ON;");

    if (!readonly) {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec(SCHEMA_SQL);
      const existingMeta = db.prepare("SELECT version FROM schema_meta LIMIT 1").get();
      if (!existingMeta) {
        db.prepare("INSERT INTO schema_meta (version, updated_at) VALUES (?, ?)").run(
          SCHEMA_VERSION,
          new Date().toISOString(),
        );
      } else if (existingMeta.version !== SCHEMA_VERSION) {
        throw taskError(
          TASK_ERROR.STATE_CONFLICT,
          `unsupported schema version ${existingMeta.version}; expected ${SCHEMA_VERSION}`,
          { foundVersion: existingMeta.version, expectedVersion: SCHEMA_VERSION },
        );
      }
    } else {
      const meta = db.prepare("SELECT version FROM schema_meta LIMIT 1").get();
      if (meta && meta.version !== SCHEMA_VERSION) {
        throw taskError(
          TASK_ERROR.STATE_CONFLICT,
          `unsupported schema version ${meta.version}; expected ${SCHEMA_VERSION}`,
          { foundVersion: meta.version, expectedVersion: SCHEMA_VERSION },
        );
      }
    }
  } catch (err) {
    try {
      db.close();
    } catch {
      // best effort
    }
    throw err;
  }

  const runImmediateAttempt = (fn) => {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn(db);
      if (result && typeof result.then === "function") {
        throw new Error("withWriteTx callback must be synchronous");
      }
      db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // ROLLBACK can fail if SQLite already auto-rolled back
      }
      throw error;
    }
  };

  return {
    path: dbPath,
    readonly: Boolean(readonly),
    db,

    get closed() {
      return closed;
    },

    /** Execute a synchronous read callback against the store. */
    read(fn) {
      ensureOpen();
      return fn(db);
    },

    /**
     * Execute a synchronous write callback inside `BEGIN IMMEDIATE` ... `COMMIT`.
     * Calls on the same store handle serialize cleanly, and cross-connection
     * `SQLITE_BUSY` contention retries with jittered backoff.
     */
    withWriteTx(fn) {
      ensureOpen();
      if (readonly) {
        return Promise.reject(taskError(TASK_ERROR.ACCESS_DENIED, "cannot write to a readonly task store"));
      }
      if (typeof fn !== "function") {
        return Promise.reject(validationFailed("withWriteTx expects a function"));
      }

      const task = txChain.then(async () => {
        ensureOpen();
        let attempt = 0;
        while (true) {
          try {
            return runImmediateAttempt(fn);
          } catch (error) {
            if (!isSqliteBusyError(error) || attempt >= maxRetries) {
              throw error;
            }
            attempt += 1;
            const jitter = Math.floor(Math.random() * retryDelayMs);
            await sleep(retryDelayMs * attempt + jitter);
          }
        }
      });

      txChain = task.catch(() => {});
      return task;
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
