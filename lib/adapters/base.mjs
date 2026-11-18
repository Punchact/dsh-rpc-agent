// Shared runtime adapter contract (§8.1) and six-state report constructor (§5.3).

import { TASK_ERROR, taskError } from "../tasks/errors.mjs";

export const ADAPTER_OPERATIONS = Object.freeze([
  "probe",
  "start",
  "inspect",
  "sendInput",
  "cancel",
  "events",
  "decideApproval",
]);

export const REPORT_STATES = Object.freeze([
  "progress",
  "waiting",
  "ready",
  "blocked",
  "failed",
  "dropped",
]);

const REPORT_STATE_SET = new Set(REPORT_STATES);

/**
 * Verify that `adapter` implements all seven §8.1 operations as functions.
 */
export function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw taskError(TASK_ERROR.INVALID_ADAPTER, "adapter must be an object");
  }
  for (const op of ADAPTER_OPERATIONS) {
    if (typeof adapter[op] !== "function") {
      throw taskError(TASK_ERROR.INVALID_ADAPTER, `adapter is missing operation "${op}"`, {
        operation: op,
      });
    }
  }
  return adapter;
}

/**
 * Construct and validate a normalized six-state adapter report (§5.3).
 */
export function reportOf(state, payload = {}) {
  if (typeof state !== "string" || !REPORT_STATE_SET.has(state)) {
    throw taskError(
      TASK_ERROR.REPORT_INVALID,
      `invalid report state "${String(state)}"; expected one of ${REPORT_STATES.join("|")}`,
      { state },
    );
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw taskError(TASK_ERROR.REPORT_INVALID, "report payload must be an object", { state });
  }
  return { ...payload, state };
}
