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
] as const);

export type AdapterOperation = (typeof ADAPTER_OPERATIONS)[number];

export const REPORT_STATES = Object.freeze([
  "progress",
  "waiting",
  "ready",
  "blocked",
  "failed",
  "dropped",
] as const);

export type KnownReportState = (typeof REPORT_STATES)[number];
export type ReportState = KnownReportState;

const REPORT_STATE_SET: ReadonlySet<string> = new Set(REPORT_STATES);
const ADAPTER_OPERATION_SET: ReadonlySet<string> = new Set(ADAPTER_OPERATIONS);

export type AdapterControlName = "start" | "steer" | "cancel" | "inspect" | "approval" | "events";

export interface AdapterLocator {
  kind?: string;
  sessionId?: string;
  cascadeId?: string;
  threadId?: string;
  turnId?: string | null;
  model?: string;
  httpPort?: number;
  lsVersion?: string;
  binary?: string;
  binarySource?: string;
  version?: string;
  [key: string]: unknown;
}

export interface AdapterContext {
  task?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  locator?: AdapterLocator;
  [key: string]: unknown;
}

export interface NormalizedAttention {
  kind: string;
  prompt: string;
  questionId?: string;
  approvalId?: string;
  toolName?: string;
  scope?: Record<string, unknown>;
  options?: unknown[];
  [key: string]: unknown;
}

export interface AgentReport {
  state: KnownReportState | (string & {});
  result?: unknown;
  resultValid?: boolean;
  evidence?: unknown;
  attention?: NormalizedAttention | NormalizedAttention[];
  reason?: string;
  failureClass?: string;
  droppedBy?: string;
  observedStatus?: string;
  observedType?: string;
  observedMethod?: string;
  [key: string]: unknown;
}

export interface AdapterProbeResult {
  ok: boolean;
  elapsedMs: number;
  reason?: string | undefined;
  controls?: Record<AdapterControlName, boolean>;
  version?: string | null;
  httpPort?: number;
  binary?: string;
  source?: string;
  handshake?: string;
  serverInfo?: unknown;
  stderrTail?: string;
}

export interface AdapterStartResult {
  accepted: boolean;
  locator: AdapterLocator;
  warning?: string;
}

export interface AdapterSendInputResult {
  accepted: boolean;
  [key: string]: unknown;
}

export interface AdapterCancelResult {
  requestAccepted: boolean;
  stopped?: boolean;
  confirmedStopped?: boolean;
  [key: string]: unknown;
}

export interface AdapterEventEntry {
  adapterEventId: string;
  report?: AgentReport;
  stepIndex?: number;
  type?: unknown;
  status?: unknown;
}

export interface AdapterEventsResult {
  events: AdapterEventEntry[];
  nextCursor: unknown;
  report?: AgentReport;
  droppedEvents?: number;
  droppedApprovals?: number;
  unknownMethods?: number;
  protocolError?: string;
}

export interface AdapterDecideApprovalResult {
  accepted: boolean;
  [key: string]: unknown;
}

export interface RuntimeAdapter {
  kind?: string;
  probe: () => Promise<AdapterProbeResult>;
  start: (arg1?: any, arg2?: any) => Promise<AdapterStartResult>;
  inspect: (arg1?: any, arg2?: any) => Promise<AgentReport | { report: AgentReport; adapterEventId: string }>;
  sendInput: (arg1?: any, arg2?: any, arg3?: any) => Promise<AdapterSendInputResult>;
  cancel: (arg1?: any, arg2?: any) => Promise<AdapterCancelResult>;
  events: (arg1?: any, arg2?: any, arg3?: any) => Promise<AdapterEventsResult>;
  decideApproval: (arg1?: any, arg2?: any, arg3?: any) => Promise<AdapterDecideApprovalResult>;
}

type RuntimeOperationKeys = Exclude<keyof RuntimeAdapter, "kind">;
type AssertAdapterOpsExhaustive = AdapterOperation extends RuntimeOperationKeys
  ? RuntimeOperationKeys extends AdapterOperation
    ? true
    : never
  : never;
const _adapterOpsExhaustive: AssertAdapterOpsExhaustive = true;
void _adapterOpsExhaustive;

export function isAdapterOperation(op: unknown): op is AdapterOperation {
  return typeof op === "string" && ADAPTER_OPERATION_SET.has(op);
}

export function assertAdapterOperation(op: unknown): AdapterOperation {
  if (!isAdapterOperation(op)) {
    throw taskError(TASK_ERROR.INVALID_ADAPTER, `unknown adapter operation "${String(op)}"`, {
      operation: op,
    });
  }
  return op;
}

/**
 * Verify that `adapter` implements all seven §8.1 operations as functions.
 */
export function validateAdapter<T extends RuntimeAdapter>(adapter: T): T {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw taskError(TASK_ERROR.INVALID_ADAPTER, "adapter must be an object");
  }
  const record = adapter as unknown as Record<string, unknown>;
  for (const op of ADAPTER_OPERATIONS) {
    if (typeof record[op] !== "function") {
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
export function reportOf<TPayload extends Record<string, unknown> = Record<string, unknown>>(
  state: KnownReportState,
  payload: TPayload = {} as TPayload,
): AgentReport & TPayload {
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
} as const);

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
} as const);

export type AdapterReasonCode = keyof typeof ADAPTER_REASON_MESSAGES;

export interface SanitizedAdapterFailure {
  code: string | null;
  kind: string | null;
  phase: string | null;
  httpStatus: number | null;
  reason: AdapterReasonCode | null;
  message: string;
}

export type AdapterError = SanitizedAdapterFailure;

function sanitizeShortId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SHORT_ID_LEN) return null;
  return SHORT_ID_RE.test(trimmed) ? trimmed : null;
}

function sanitizeHttpStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value === "string" && /^[1-5]\d{2}$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Normalize an arbitrary adapter/transport error into a safe summary free of
 * raw exception text, local paths, URLs, ports, tokens, or stack traces.
 */
export function sanitizeAdapterFailure(error: unknown): AdapterError {
  const errObj = (error && typeof error === "object" ? error : {}) as {
    taskCode?: unknown;
    code?: unknown;
    kind?: unknown;
    phase?: unknown;
    httpStatus?: unknown;
    status?: unknown;
    name?: unknown;
    data?: { kind?: unknown; phase?: unknown; httpStatus?: unknown; reason?: unknown };
  };
  const rawCode = errObj.taskCode ?? errObj.code;
  const code = sanitizeShortId(typeof rawCode === "number" ? String(rawCode) : rawCode);
  const kind = sanitizeShortId(errObj.data?.kind ?? errObj.kind);
  const phase = sanitizeShortId(errObj.data?.phase ?? errObj.phase);
  const httpStatus = sanitizeHttpStatus(errObj.data?.httpStatus ?? errObj.httpStatus ?? errObj.status);

  const errName = sanitizeShortId(errObj.name);
  const reasonTag = sanitizeShortId(errObj.data?.reason);
  const reason: AdapterReasonCode | null =
    reasonTag !== null && Object.prototype.hasOwnProperty.call(ADAPTER_REASON_MESSAGES, reasonTag)
      ? (reasonTag as AdapterReasonCode)
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

  let message: string;
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
