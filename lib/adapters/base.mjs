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

const SHORT_ID_RE = /^[A-Za-z0-9_.:-]+$/;
const MAX_SHORT_ID_LEN = 64;

export const ADAPTER_FAILURE_MESSAGES = Object.freeze({
  unavailable: "the execution backend is unavailable",
  timeout: "the execution backend did not answer in time",
  rejected: "the execution backend rejected the request",
});

function sanitizeShortId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SHORT_ID_LEN) return null;
  return SHORT_ID_RE.test(trimmed) ? trimmed : null;
}

function sanitizeHttpStatus(value) {
  if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value === "string" && /^[1-5]\d{2}$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Normalize an arbitrary adapter/transport error into a safe summary free of
 * raw exception text, local paths, URLs, ports, tokens, or stack traces.
 */
export function sanitizeAdapterFailure(error) {
  const rawCode = error?.taskCode ?? error?.code;
  const code = sanitizeShortId(typeof rawCode === "number" ? String(rawCode) : rawCode);
  const kind = sanitizeShortId(error?.data?.kind ?? error?.kind);
  const phase = sanitizeShortId(error?.data?.phase ?? error?.phase);
  const httpStatus = sanitizeHttpStatus(error?.data?.httpStatus ?? error?.httpStatus ?? error?.status);

  const errName = sanitizeShortId(error?.name);
  const reasonTag = sanitizeShortId(error?.data?.reason);
  const isTimeout =
    code === "adapter_timeout" ||
    code === "ETIMEDOUT" ||
    code === "ABORT_ERR" ||
    code === "TimeoutError" ||
    kind === "adapter_timeout" ||
    phase === "timeout" ||
    errName === "TimeoutError" ||
    errName === "AbortError" ||
    reasonTag === "timeout";

  const isUnavailable =
    code === "ADAPTER_UNAVAILABLE" ||
    code === "adapter_unavailable" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ENOENT" ||
    kind === "ADAPTER_UNAVAILABLE" ||
    kind === "adapter_unavailable";

  let message;
  if (isTimeout) {
    message = ADAPTER_FAILURE_MESSAGES.timeout;
  } else if (isUnavailable && !(httpStatus !== null && httpStatus >= 400 && httpStatus < 500)) {
    message = ADAPTER_FAILURE_MESSAGES.unavailable;
  } else {
    message = ADAPTER_FAILURE_MESSAGES.rejected;
  }

  return {
    code,
    kind,
    phase,
    httpStatus,
    message,
  };
}
