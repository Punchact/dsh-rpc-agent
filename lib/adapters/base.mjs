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

/**
 * Reasons an adapter is allowed to publish, mapped to text the operator can act
 * on. SEC-2 forbids echoing raw exception text (paths, ports, URLs, tokens), so
 * the transport detail stays in logger.debug and only these curated strings
 * reach the ledger. Adding a reason here is a deliberate code change: an adapter
 * cannot smuggle arbitrary prose into a task receipt by setting data.reason.
 */
export const ADAPTER_REASON_MESSAGES = Object.freeze({
  binary_not_found:
    "the execution backend binary was not found; install it or set tasksAdapters.<kind>.binary in the plugin config",
  spawn_error: "the execution backend process could not be started",
  process_exited: "the execution backend exited before the turn completed",
  daemon_dir_unreadable: "the Antigravity daemon directory is unreadable",
  no_alive_hub: "no running Antigravity language server was found; start Antigravity and retry",
  fetch_missing: "this Node runtime has no usable fetch transport for the Antigravity RPC",
  body_read_error: "the Antigravity RPC response body could not be read",
  response_too_large: "the Antigravity RPC response exceeded the size cap",
  rpc_http_error: "the Antigravity RPC rejected the request",
  protocol_error: "the Codex app-server reported a protocol error",
  rpc_error: "the Codex app-server rejected the request",
  session_closed: "the Codex app-server session was closed",
  session_not_attached: "the Codex app-server session is not attached",
  missing_thread_id: "the Codex app-server did not return a thread id",
  missing_session_id: "the DSH session handle is missing",
  approval_not_found: "the requested approval is unknown to the backend",
  timeout: "the execution backend did not answer in time",
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
  const reason =
    reasonTag !== null && Object.prototype.hasOwnProperty.call(ADAPTER_REASON_MESSAGES, reasonTag)
      ? reasonTag
      : null;
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
  if (reason !== null) {
    // A whitelisted reason is more useful than the coarse category message.
    message = ADAPTER_REASON_MESSAGES[reason];
  } else if (isTimeout) {
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
    reason,
    message,
  };
}
