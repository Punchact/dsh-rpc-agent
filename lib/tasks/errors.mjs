// Typed errors for the task center. Built on `RpcError` so JSON-RPC transport
// (`lib/protocol.mjs` and `lib/http.mjs`) preserves numeric RPC codes while
// callers and tests can branch deterministically on `error.taskCode` and
// `error.data.code`.

import { CODE, RpcError } from "../protocol.mjs";

export const TASK_ERROR = Object.freeze({
  STATE_CONFLICT: "STATE_CONFLICT",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  CONTROL_UNSUPPORTED: "CONTROL_UNSUPPORTED",
  CURSOR_EXPIRED: "CURSOR_EXPIRED",
  REPORT_INVALID: "REPORT_INVALID",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  NOT_FOUND: "NOT_FOUND",
  ACCESS_DENIED: "ACCESS_DENIED",
  PREVIEW_STALE: "PREVIEW_STALE",
  SCHEMA_INVALID: "SCHEMA_INVALID",
});

const RPC_CODE_FOR_TASK_ERROR = Object.freeze({
  [TASK_ERROR.STATE_CONFLICT]: CODE.busy,
  [TASK_ERROR.IDEMPOTENCY_CONFLICT]: CODE.busy,
  [TASK_ERROR.CONTROL_UNSUPPORTED]: CODE.invalidParams,
  [TASK_ERROR.CURSOR_EXPIRED]: CODE.invalidParams,
  [TASK_ERROR.REPORT_INVALID]: CODE.invalidParams,
  [TASK_ERROR.VALIDATION_FAILED]: CODE.invalidParams,
  [TASK_ERROR.NOT_FOUND]: CODE.notFound,
  [TASK_ERROR.ACCESS_DENIED]: CODE.forbidden,
  [TASK_ERROR.PREVIEW_STALE]: CODE.invalidParams,
  [TASK_ERROR.SCHEMA_INVALID]: CODE.invalidParams,
});

/**
 * Construct a task-center error shaped like `badRequest` (`RpcError`),
 * carrying the stable string `taskCode` on both `error.taskCode` and
 * `error.data.code` / `error.data.kind`.
 */
export function taskError(taskCode, message, data = {}) {
  const rpcCode = RPC_CODE_FOR_TASK_ERROR[taskCode] ?? CODE.server;
  const payload = { kind: taskCode, code: taskCode, ...data };
  const err = new RpcError(rpcCode, message, payload);
  err.taskCode = taskCode;
  return err;
}

export function stateConflict(message, data) {
  return taskError(TASK_ERROR.STATE_CONFLICT, message, data);
}

export function idempotencyConflict(message, data) {
  return taskError(TASK_ERROR.IDEMPOTENCY_CONFLICT, message, data);
}

export function controlUnsupported(message, data) {
  return taskError(TASK_ERROR.CONTROL_UNSUPPORTED, message, data);
}

export function cursorExpired(message, data) {
  return taskError(TASK_ERROR.CURSOR_EXPIRED, message, data);
}

export function reportInvalid(message, data) {
  return taskError(TASK_ERROR.REPORT_INVALID, message, data);
}

export function validationFailed(message, data) {
  return taskError(TASK_ERROR.VALIDATION_FAILED, message, data);
}

export function notFoundError(message, data) {
  return taskError(TASK_ERROR.NOT_FOUND, message, data);
}

export function accessDeniedError(message, data) {
  return taskError(TASK_ERROR.ACCESS_DENIED, message, data);
}

export function isTaskError(error, taskCode) {
  if (!error || typeof error !== "object") return false;
  const code = error.taskCode ?? error.data?.code ?? error.data?.kind;
  return taskCode ? code === taskCode : Object.values(TASK_ERROR).includes(code);
}
