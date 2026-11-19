// Reconciliation for stalled/unconfirmed tasks (`needs_reconcile` or `cancel_requested`).
// Closes any lingering active attempt (`side_effect_active = 0`) and advances the
// task through the state machine with a `reconcile.applied` event.

import { notFoundError, stateConflict, validationFailed } from "./errors.mjs";
import { transitionInTx } from "./state-machine.mjs";

const OBSERVED_STATES = new Set(["succeeded", "failed", "cancelled"]);
const RECONCILABLE_STATES = new Set(["needs_reconcile", "cancel_requested"]);

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationFailed(`\`${field}\` must be a non-empty string`, { field });
  }
  return value.trim();
}

/**
 * Reconcile a `needs_reconcile` or `cancel_requested` task from external evidence.
 *
 * @param {object} _engine Reserved engine handle (kept for caller symmetry)
 * @param {import("./store.mjs").TaskStore} store SQLite store from `openStore`
 * @param {object} params
 * @param {string} params.taskId
 * @param {object} params.evidence `{ observedState: 'succeeded'|'failed'|'cancelled', note?, adapterEventId?, result?, resultValid?, failureClass? }`
 */
export async function reconcileTask(_engine, store, params = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw validationFailed("params must be an object");
  }
  const taskId = requireNonEmptyString(params.taskId, "taskId");
  const evidence = params.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw validationFailed("`evidence` must be an object", { field: "evidence" });
  }
  const observedState = requireNonEmptyString(evidence.observedState, "evidence.observedState");
  if (!OBSERVED_STATES.has(observedState)) {
    throw validationFailed(
      `evidence.observedState must be one of succeeded|failed|cancelled; got "${observedState}"`,
      { field: "evidence.observedState", observedState },
    );
  }

  return store.withWriteTx((db) => {
    const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    if (!task) {
      throw notFoundError(`task not found: ${taskId}`, { taskId });
    }
    if (!RECONCILABLE_STATES.has(task.status)) {
      throw stateConflict(
        `task ${taskId} in state "${task.status}" cannot be reconciled (expected needs_reconcile or cancel_requested)`,
        { taskId, status: task.status, stateVersion: task.state_version },
      );
    }

    const now = new Date().toISOString();
    const attemptStatus = observedState === "succeeded" ? "completed" : observedState;

    const closedAttempts = db
      .prepare(
        `UPDATE attempts
         SET side_effect_active = 0,
             status = ?,
             failure_class = COALESCE(failure_class, ?),
             ended_at = COALESCE(ended_at, ?),
             updated_at = ?
         WHERE task_id = ? AND side_effect_active = 1`,
      )
      .run(
        attemptStatus,
        observedState === "failed" ? evidence.failureClass ?? "reconciled_failed" : null,
        now,
        now,
        taskId,
      );

    db.prepare(
      `UPDATE attention
       SET status = 'closed',
           resolved_by = 'reconcile',
           resolution_json = ?,
           resolved_at = ?
       WHERE task_id = ? AND status = 'open'`,
    ).run(JSON.stringify({ observedState, note: evidence.note ?? null }), now, taskId);

    db.prepare(
      `UPDATE approvals
       SET status = 'closed',
           decided_at = COALESCE(decided_at, ?)
       WHERE task_id = ? AND status = 'pending'`,
    ).run(now, taskId);

    const patch = { activeAttemptId: null };
    if (observedState === "succeeded") {
      patch.resultJson = JSON.stringify(evidence.result ?? null);
      patch.resultValid = evidence.resultValid === false ? false : true;
    } else if (observedState === "failed") {
      patch.errorJson = JSON.stringify({
        failureClass: evidence.failureClass ?? "reconcile_failed",
        message: evidence.note ?? "reconciled as failed",
      });
    }

    const tr = transitionInTx(db, {
      taskId,
      expectedStateVersion: task.state_version,
      to: observedState,
      reason: evidence.note ?? `reconciled to ${observedState}`,
      evidence,
      eventType: "reconcile.applied",
      source: "reconcile",
      attemptId: task.active_attempt_id ?? null,
      adapterEventId: evidence.adapterEventId ?? null,
      payload: {
        observedState,
        note: evidence.note ?? null,
        attemptsClosed: closedAttempts.changes,
        // Who closed it. Reconcile is an operator action; W3 adds the ACL check.
        actor: typeof params.principalId === "string" ? params.principalId : null,
      },
      patch,
    });

    return {
      taskId,
      from: tr.from,
      status: tr.to,
      stateVersion: tr.stateVersion,
      attemptsClosed: closedAttempts.changes,
      event: tr.event,
    };
  });
}
