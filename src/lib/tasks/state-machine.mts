// 11-state task lifecycle machine (§5.2) with optimistic locking on
// `state_version` and monotonic per-task event appending.

import { randomUUID } from "node:crypto";

import { notFoundError, stateConflict, validationFailed } from "./errors.mjs";

export const TASK_STATES = Object.freeze([
  "queued",
  "dispatching",
  "running",
  "waiting_input",
  "waiting_approval",
  "cancel_requested",
  "needs_reconcile",
  "review_pending",
  "succeeded",
  "failed",
  "cancelled",
] as const);

export type TaskStatus = (typeof TASK_STATES)[number];

export type TerminalTaskStatus = "succeeded" | "failed" | "cancelled";

export const TERMINAL_STATES: ReadonlySet<TaskStatus> = Object.freeze(
  new Set<TaskStatus>(["succeeded", "failed", "cancelled"]),
);

const TASK_STATE_SET: ReadonlySet<string> = new Set(TASK_STATES);

/**
 * Legal state transitions per §5.2 & §5.3.
 * Terminal states (`succeeded`, `failed`, `cancelled`) have no outgoing edges:
 * late runtime evidence can only be appended to `events`.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze<
  Record<TaskStatus, readonly TaskStatus[]>
>({
  queued: Object.freeze(["dispatching", "cancel_requested", "needs_reconcile", "cancelled"]),
  dispatching: Object.freeze(["running", "cancel_requested", "needs_reconcile", "failed", "cancelled"]),
  running: Object.freeze([
    "waiting_input",
    "waiting_approval",
    "cancel_requested",
    "needs_reconcile",
    "review_pending",
    "failed",
    "cancelled",
  ]),
  waiting_input: Object.freeze([
    "running",
    "waiting_approval",
    "cancel_requested",
    "needs_reconcile",
    "review_pending",
    "failed",
    "cancelled",
  ]),
  waiting_approval: Object.freeze([
    "running",
    "waiting_input",
    "cancel_requested",
    "needs_reconcile",
    "review_pending",
    "failed",
    "cancelled",
  ]),
  cancel_requested: Object.freeze(["cancelled", "review_pending", "succeeded", "failed", "needs_reconcile"]),
  needs_reconcile: Object.freeze([
    "queued",
    "dispatching",
    "running",
    "review_pending",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  review_pending: Object.freeze(["succeeded", "failed", "needs_reconcile", "cancelled"]),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export interface SqlStatement {
  get(...params: any[]): Record<string, unknown> | undefined;
  run(...params: any[]): { changes: number | bigint };
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
}

export interface TaskStore {
  withWriteTx<T>(fn: (db: SqlDatabase) => T): Promise<T>;
}

export interface AppendEventParams {
  taskId: string;
  attemptId?: string | null;
  type: string;
  source?: string;
  adapterEventId?: string | number | null;
  payload?: Record<string, unknown>;
  evidence?: unknown;
  createdAt?: string;
}

export interface AppendEventResult {
  eventId: string;
  seq: number;
  type: string;
  createdAt: string;
  deduplicated: boolean;
}

export interface TransitionPatch {
  activeAttemptId?: string | null;
  cancelRequestedAt?: string | null;
  cancelReason?: string | null;
  resultJson?: string | null;
  resultValid?: boolean | null;
  errorJson?: string | null;
}

export interface TransitionParams {
  taskId: string;
  expectedStateVersion: number;
  to: TaskStatus;
  reason?: string;
  evidence?: unknown;
  eventType?: string | null;
  source?: string;
  attemptId?: string | null;
  adapterEventId?: string | number | null;
  payload?: Record<string, unknown>;
  patch?: TransitionPatch;
}

export interface TransitionResult {
  taskId: string;
  from: string;
  to: TaskStatus;
  stateVersion: number;
  updatedAt: string;
  completedAt: string | null;
  event: AppendEventResult;
}

export function isValidState(state: unknown): state is TaskStatus {
  return typeof state === "string" && TASK_STATE_SET.has(state);
}

export function isTerminalState(state: unknown): state is TerminalTaskStatus {
  return (TERMINAL_STATES as ReadonlySet<string>).has(state as string);
}

export function canTransition(from: unknown, to: unknown): boolean {
  if (!isValidState(from) || !isValidState(to)) return false;
  if (TERMINAL_STATES.has(from)) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Append a monotonic event row for `taskId` inside an active write transaction.
 * Deduplicates when `(taskId, attemptId, adapterEventId)` was already recorded.
 */
export function appendEventInTx(
  db: SqlDatabase,
  {
    taskId,
    attemptId = null,
    type,
    source = "engine",
    adapterEventId = null,
    payload = {},
    evidence = null,
    createdAt = new Date().toISOString(),
  }: AppendEventParams,
): AppendEventResult {
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    throw validationFailed("`taskId` must be a non-empty string");
  }
  if (typeof type !== "string" || type.trim().length === 0) {
    throw validationFailed("`type` must be a non-empty string");
  }

  if (adapterEventId !== null && adapterEventId !== undefined && attemptId !== null && attemptId !== undefined) {
    const existing = db
      .prepare(
        `SELECT event_id, seq, type, created_at
         FROM events
         WHERE task_id = ? AND attempt_id = ? AND adapter_event_id = ?`,
      )
      .get(taskId, attemptId, String(adapterEventId)) as
      | { event_id: string; seq: number; type: string; created_at: string }
      | undefined;
    if (existing) {
      return {
        eventId: existing.event_id,
        seq: existing.seq,
        type: existing.type,
        createdAt: existing.created_at,
        deduplicated: true,
      };
    }
  }

  const nextRow = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM events WHERE task_id = ?")
    .get(taskId) as { next_seq: number };
  const seq = nextRow.next_seq;
  const eventId = `evt_${randomUUID()}`;
  const payloadJson = JSON.stringify(payload ?? {});
  const evidenceJson = evidence === null || evidence === undefined ? null : JSON.stringify(evidence);

  db.prepare(
    `INSERT INTO events (
       event_id, task_id, seq, attempt_id, type, source, adapter_event_id, payload_json, evidence_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    taskId,
    seq,
    attemptId,
    type,
    source,
    adapterEventId === undefined ? null : adapterEventId,
    payloadJson,
    evidenceJson,
    createdAt,
  );

  return { eventId, seq, type, createdAt, deduplicated: false };
}

export async function appendEvent(store: TaskStore, params: AppendEventParams): Promise<AppendEventResult> {
  return store.withWriteTx((db) => appendEventInTx(db, params));
}

/**
 * Perform an optimistic-locked state transition inside an existing write transaction.
 */
export function transitionInTx(
  db: SqlDatabase,
  {
    taskId,
    expectedStateVersion,
    to,
    reason = "",
    evidence = null,
    eventType = null,
    source = "engine",
    attemptId = undefined,
    adapterEventId = null,
    payload = {},
    patch = {},
  }: TransitionParams,
): TransitionResult {
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    throw validationFailed("`taskId` must be a non-empty string");
  }
  if (!isValidState(to)) {
    throw validationFailed(`unknown target task state: "${String(to)}"`, { to });
  }
  if (!Number.isInteger(expectedStateVersion) || expectedStateVersion < 1) {
    throw validationFailed("`expectedStateVersion` must be a positive integer", {
      expectedStateVersion,
    });
  }

  const row = db
    .prepare(
      `SELECT task_id, status, state_version, active_attempt_id
       FROM tasks WHERE task_id = ?`,
    )
    .get(taskId) as
    | { task_id: string; status: string; state_version: number; active_attempt_id: string | null }
    | undefined;
  if (!row) {
    throw notFoundError(`task not found: ${taskId}`, { taskId });
  }

  if ((TERMINAL_STATES as ReadonlySet<string>).has(row.status)) {
    throw stateConflict(
      `task ${taskId} is in terminal state "${row.status}" and cannot transition to "${to}"`,
      { taskId, from: row.status, to, stateVersion: row.state_version },
    );
  }

  if (row.state_version !== expectedStateVersion) {
    throw stateConflict(
      `state_version conflict for task ${taskId}: expected ${expectedStateVersion}, actual ${row.state_version}`,
      {
        taskId,
        expectedStateVersion,
        actualStateVersion: row.state_version,
        currentState: row.status,
      },
    );
  }

  if (!canTransition(row.status, to)) {
    throw stateConflict(`illegal state transition for task ${taskId}: "${row.status}" -> "${to}"`, {
      taskId,
      from: row.status,
      to,
      stateVersion: row.state_version,
    });
  }

  const now = new Date().toISOString();
  const nextVersion = row.state_version + 1;
  const terminal = TERMINAL_STATES.has(to);

  const sets = ["status = ?", "state_version = ?", "updated_at = ?"];
  const args: unknown[] = [to, nextVersion, now];

  if (terminal) {
    sets.push("completed_at = COALESCE(completed_at, ?)");
    args.push(now);
  }
  if (patch.activeAttemptId !== undefined) {
    sets.push("active_attempt_id = ?");
    args.push(patch.activeAttemptId);
  }
  if (patch.cancelRequestedAt !== undefined) {
    sets.push("cancel_requested_at = ?");
    args.push(patch.cancelRequestedAt);
  }
  if (patch.cancelReason !== undefined) {
    sets.push("cancel_reason = ?");
    args.push(patch.cancelReason);
  }
  if (patch.resultJson !== undefined) {
    sets.push("result_json = ?");
    args.push(patch.resultJson);
  }
  if (patch.resultValid !== undefined) {
    sets.push("result_valid = ?");
    args.push(patch.resultValid === null ? null : patch.resultValid ? 1 : 0);
  }
  if (patch.errorJson !== undefined) {
    sets.push("error_json = ?");
    args.push(patch.errorJson);
  }

  args.push(taskId, expectedStateVersion);
  const res = db
    .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE task_id = ? AND state_version = ?`)
    .run(...args);

  if (res.changes !== 1) {
    throw stateConflict(`concurrent state modification on task ${taskId}`, { taskId });
  }

  const resolvedAttemptId = attemptId === undefined ? row.active_attempt_id : attemptId;
  const evt = appendEventInTx(db, {
    taskId,
    attemptId: resolvedAttemptId,
    type: eventType ?? `task.state.${to}`,
    source,
    adapterEventId,
    payload: {
      from: row.status,
      to,
      stateVersion: nextVersion,
      ...(reason ? { reason } : {}),
      ...payload,
    },
    evidence,
    createdAt: now,
  });

  return {
    taskId,
    from: row.status,
    to,
    stateVersion: nextVersion,
    updatedAt: now,
    completedAt: terminal ? now : null,
    event: evt,
  };
}

/**
 * Optimistic-locked state transition wrapped in `store.withWriteTx`.
 */
export async function transition(store: TaskStore, params: TransitionParams): Promise<TransitionResult> {
  return store.withWriteTx((db) => transitionInTx(db, params));
}
