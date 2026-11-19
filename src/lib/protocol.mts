// JSON-RPC 2.0 wire helpers plus the mapping from DSH `RemoteError` codes to
// the application-error range. Everything here is transport-only: no service
// access, so it stays trivially testable outside a Host process.

export const RPC_VERSION = "2.0" as const;

export const CODE = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  server: -32000,
  unauthorized: -32001,
  forbidden: -32002,
  notFound: -32003,
  busy: -32004,
  timeout: -32005,
  cancelled: -32006,
} as const;

export type RpcCode = (typeof CODE)[keyof typeof CODE];
export type JsonRpcId = string | number | null;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: typeof RPC_VERSION;
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcFailure {
  jsonrpc: typeof RPC_VERSION;
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method: string;
  params?: unknown;
}

/** An error that already knows the JSON-RPC code it should surface as. */
export class RpcError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export function isRpcError(error: unknown): error is RpcError {
  return error instanceof RpcError;
}

export function badRequest(message: string, data?: unknown): RpcError {
  return new RpcError(CODE.invalidParams, message, data);
}

export function ok<T = unknown>(id: JsonRpcId, result: T): JsonRpcSuccess<T> {
  return { jsonrpc: RPC_VERSION, id, result };
}

export function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  const error: JsonRpcErrorObject = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: RPC_VERSION, id, error };
}

/**
 * Map any thrown value onto a JSON-RPC error object. DSH `RemoteError`s carry a
 * stable `code` string such as `session/not-found`; those become typed
 * application errors so callers can branch on `data.kind` instead of parsing
 * prose.
 */
export function describeError(error: unknown): JsonRpcErrorObject {
  if (error instanceof RpcError) {
    return { code: error.code, message: error.message, data: error.data };
  }
  if (isRemoteError(error)) {
    const remote = error.code;
    const mapped = REMOTE_CODE_MAP[remote] ?? CODE.server;
    return {
      code: mapped,
      message: error.message || remote,
      data: { kind: remote, details: safeDetails(error.details) },
    };
  }
  if (error instanceof Error) {
    const name = error.name;
    if (name === "AbortError" || name === "TimeoutError") {
      return { code: CODE.cancelled, message: error.message || "aborted", data: { kind: name } };
    }
    return { code: CODE.internal, message: error.message, data: { kind: name || "Error" } };
  }
  return { code: CODE.internal, message: String(error), data: { kind: typeof error } };
}

// Codes observed in @deepseek-ai/dsh-api-session-controller. Codes absent here
// still surface as `CODE.server` with the original `data.kind`, so an unknown
// code loses precision but never information.
const REMOTE_CODE_MAP: Record<string, RpcCode> = {
  // Gone, or never a valid id.
  "session/not-found": CODE.notFound,
  "session/queue-item-not-found": CODE.notFound,
  "workspace/not-found": CODE.notFound,
  "subagent/not-found": CODE.notFound,
  // Owned by someone else right now.
  "session/agent-busy": CODE.busy,
  "session/writer-held": CODE.busy,
  "session/conflict": CODE.busy,
  "agent-preset/conflict": CODE.busy,
  // The request asked for something the Host will not accept.
  "gateway/bad-request": CODE.invalidParams,
  "session/invalid-time-zone": CODE.invalidParams,
  "session/attachment-invalid": CODE.invalidParams,
  "session/title-invalid": CODE.invalidParams,
  "session/steer-unavailable": CODE.invalidParams,
  "agent-preset/not-found": CODE.invalidParams,
  "subagent/unauthorized": CODE.forbidden,
  // The caller asked for a model or provider this profile cannot reach.
  "session/model-unavailable": CODE.invalidParams,
  "session/provider-models-unavailable": CODE.invalidParams,
  "session/provider-credentials-unavailable": CODE.invalidParams,
  // Transport-level.
  "gateway/cancelled": CODE.cancelled,
  "gateway/internal": CODE.internal,
  // Persistence failed after something was already created.
  "session/workspace-attach-failed": CODE.internal,
};

interface DshRemoteError {
  isDSHRemoteError: true;
  code: string;
  message?: string;
  details?: unknown;
}

function isRemoteError(error: unknown): error is DshRemoteError {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { isDSHRemoteError?: unknown }).isDSHRemoteError === true
  );
}

function safeDetails(details: unknown): unknown {
  if (details === undefined || details === null) return undefined;
  if (typeof details !== "object") return details;
  try {
    // `details` may carry class instances; keep the JSON-safe projection only.
    return JSON.parse(JSON.stringify(details));
  } catch {
    return undefined;
  }
}

/** JSON-RPC ids are strings, numbers or null. Anything else is invalid. */
export function normalizeId(value: unknown): JsonRpcId {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  throw new RpcError(CODE.invalidRequest, "`id` must be a string, a number or null");
}

/** True when the envelope is a notification, which must never be answered. */
export function isNotification(payload: unknown): boolean {
  return payload !== null && typeof payload === "object" && !("id" in payload);
}

/** Validate the common shape of a single request object. */
export function assertRequest(payload: unknown): asserts payload is JsonRpcRequest {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RpcError(CODE.invalidRequest, "request must be a JSON object");
  }
  const req = payload as Record<string, unknown>;
  if (req.jsonrpc !== undefined && req.jsonrpc !== RPC_VERSION) {
    throw new RpcError(CODE.invalidRequest, `unsupported jsonrpc version: ${String(req.jsonrpc)}`);
  }
  if (typeof req.method !== "string" || req.method.length === 0) {
    throw new RpcError(CODE.invalidRequest, "`method` must be a non-empty string");
  }
  if (req.params !== undefined && (req.params === null || typeof req.params !== "object")) {
    throw new RpcError(CODE.invalidRequest, "`params` must be an object or an array");
  }
}

/** Coerce positional params into the object form our handlers use. */
export function paramsObject(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (Array.isArray(params)) {
    if (params.length > 1) {
      throw new RpcError(CODE.invalidParams, "positional params support at most one argument");
    }
    const [first] = params;
    if (first === undefined) return {};
    if (first === null || typeof first !== "object") {
      throw new RpcError(CODE.invalidParams, "positional param must be an object");
    }
    return first as Record<string, unknown>;
  }
  if (typeof params !== "object") {
    throw new RpcError(CODE.invalidParams, "`params` must be an object");
  }
  return params as Record<string, unknown>;
}
