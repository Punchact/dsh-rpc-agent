// Out-of-process client used by the CLI and the MCP bridge. Both run inside the
// *calling* agent's process, so they only speak HTTP to the Harness and never
// import Host modules.

import { endpointPath, readEndpoint, readTokenFromFile, type PublishedEndpoint } from "./auth.mjs";
import { MAX_WAIT_SLICE_MS } from "./config.mjs";

// Part of the slicing contract: a caller may clamp its own hint with the same
// ceiling the bridge and this client use, without importing the config module.
export { MAX_WAIT_SLICE_MS };
import { transportCode, type TransportCode } from "./transport.mjs";

export type { PublishedEndpoint, TransportCode };

export interface ClientConnectionOptions {
  url?: string | undefined;
  token?: string | undefined;
}

export interface RpcCallOptions extends ClientConnectionOptions {
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  id?: string | number | null | undefined;
}

export interface WaitForTurnOptions extends RpcCallOptions {
  sliceMs?: number | undefined;
  since?: number | undefined;
}

export interface RpcStreamOptions extends ClientConnectionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ResolvedConnection {
  url: string;
  token: string;
  endpoint: PublishedEndpoint | null;
}

export interface TransportError extends Error {
  code: TransportCode;
  cause: unknown;
  transport: true;
}

export interface ClientRpcError extends Error {
  code: number;
  data: unknown;
  status: number | undefined;
}

export interface WaitForTurnResult {
  status?: string;
  slices: number;
  waitedMs: number;
  [key: string]: unknown;
}

export type RpcStreamFrame =
  | { type: "session"; sessionId: string; cwd?: string; agentPreset?: string | null; [key: string]: unknown }
  | { type: "progress"; frame: unknown; [key: string]: unknown }
  | { type: "result"; [key: string]: unknown }
  | { type: "error"; error: { code: number; message: string; data?: unknown }; [key: string]: unknown }
  | { type: "malformed"; line: string }
  | { type: string; [key: string]: unknown };

const DEFAULT_PATH = "/dsh-rpc";

export function resolveConnection(options: ClientConnectionOptions = {}): ResolvedConnection {
  const env = process.env;

  let url = trim(options.url) || trim(env.DSH_RPC_URL);
  const endpoint = readEndpoint();

  if (!url) {
    if (endpoint?.url) url = endpoint.url;
    else {
      const base = trim(env.DSH_WEB_URL) || trim(endpoint?.origin);
      if (base) url = `${base.replace(/\/+$/, "")}${endpoint?.path ?? DEFAULT_PATH}`;
    }
  }

  let token = trim(options.token) || trim(env.DSH_RPC_TOKEN);
  if (!token) token = readTokenFromFile() ?? "";

  if (!url) {
    throw new Error(
      "cannot resolve the dsh-rpc endpoint: pass --url, set DSH_RPC_URL, or start the Harness once so it can publish " +
        endpointPath(),
    );
  }
  if (!token) {
    throw new Error(
      `cannot resolve a dsh-rpc token: pass --token, set DSH_RPC_TOKEN, or write the secret to ${endpointPath().replace(/endpoint\.json$/, "token")}`,
    );
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`dsh-rpc endpoint must be an http(s) URL, got: ${url}`);
  }

  return { url, token, endpoint };
}

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function authHeaders(token: string): { authorization: string } {
  // One header only: sending the secret twice doubles the places a proxy or a
  // shell history can capture it for no benefit.
  return { authorization: `Bearer ${token}` };
}

/** Preserve caller cancellation while enforcing the transport deadline independently. */
function requestSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal | undefined {
  const timeoutSignal = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (callerSignal && timeoutSignal) return AbortSignal.any([callerSignal, timeoutSignal]);
  return callerSignal ?? timeoutSignal;
}

// The errno recovery lives in its own module so the platform differences can be
// tested directly, without a socket (see test/client.test.mjs).

/**
 * Keep the transport failure recognisable (`code`, `name`) while making the
 * message say what the caller was doing. `fetch` alone reports "fetch failed",
 * which is useless in a CLI transcript.
 */
/** The deepest message in a `cause` chain, which is where fetch keeps the reason. */
export function deepestMessage(error: unknown, depth = 0): string {
  if (!error || typeof error !== "object" || depth > 6) return "";
  const record = error as { cause?: unknown; message?: unknown };
  if (record.cause) {
    const deeper = deepestMessage(record.cause, depth + 1);
    if (deeper) return deeper;
  }
  return typeof record.message === "string" ? record.message : "";
}

function transportError(error: unknown, label: string, options: { timeoutMs?: number }): TransportError {
  const err = (error && typeof error === "object" ? error : null) as {
    name?: unknown;
    message?: unknown;
    cause?: unknown;
  } | null;
  const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
  const code = transportCode(error);
  // "fetch failed" alone sends the reader looking at the wrong thing: the reason
  // lives one level down, and for a blocked port it is the whole story.
  const causeText = deepestMessage(err?.cause);
  const base = typeof err?.message === "string" ? err.message : String(error);
  const detail = timedOut
    ? `timed out${options.timeoutMs ? ` after ${options.timeoutMs}ms` : ""}`
    : code === "EBADPORT"
      ? `${base} (${causeText || "bad port"}) — fetch refuses this port; start the Harness so it binds another one, or pass --url`
      : causeText && causeText !== base
        ? `${base} (${causeText})`
        : base;
  const wrapped = new Error(`${label}: ${detail}`) as TransportError;
  wrapped.name = typeof err?.name === "string" ? err.name : "Error";
  wrapped.code = code;
  wrapped.cause = error;
  wrapped.transport = true;
  return wrapped;
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000;

// Only a refused handshake is retried. ECONNREFUSED means the kernel answered
// SYN with RST and the request never left this process, so a retry cannot
// double-submit a prompt. ECONNRESET / EPIPE / timeouts mean bytes may already
// have been delivered and a turn may be running, so those are reported, never
// resent.
export const RETRYABLE_CONNECT_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED"]);

export function staleEndpointError(error: unknown, connection: ResolvedConnection): TransportError {
  const err = (error && typeof error === "object" ? error : null) as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
  } | null;
  const endpoint = connection.endpoint;
  const published = endpoint?.updatedAt
    ? `last published ${endpoint.updatedAt}`
    : "no published endpoint, so the URL came from DSH_WEB_URL";
  const who = endpoint?.pid ? `pid ${endpoint.pid}, started ${endpoint.startedAt}` : "no pid recorded";
  const wrapped = new Error(
    `${String(err?.message ?? error)} — nothing is listening on ${connection.url} (${published}; ${who}). ` +
      "The Harness most likely restarted on a new port: run `dsh-rpc health --wait 15000` and retry, " +
      "or pass --url to override.",
  ) as TransportError;
  wrapped.name = typeof err?.name === "string" ? err.name : "Error";
  wrapped.code = typeof err?.code === "string" ? err.code : undefined;
  wrapped.cause = error;
  wrapped.transport = true;
  return wrapped;
}

/**
 * Resolve the endpoint, run `attempt`, and — only if the socket was refused or
 * fetch blocked a port before opening one — re-resolve and try once more when
 * the published endpoint URL actually moved.
 *
 * The Web server takes an OS-assigned port on every start (the Desktop launcher
 * asks for port 0), so a caller racing a restart can hold a port that was valid
 * a second ago (or a previous crashed run that landed on a blocked port). The
 * plugin republishes the endpoint file on every start, so re-reading it turns
 * that race into a single safe retry when the URL changed. If the endpoint URL
 * did not move, a blocked port rethrows EBADPORT verbatim instead of "nothing is
 * listening". An explicitly supplied `--url` or `DSH_RPC_URL` is never retried.
 */
export async function withEndpointRetry<T>(
  options: ClientConnectionOptions,
  attempt: (connection: ResolvedConnection) => Promise<T>,
): Promise<T> {
  const explicit = Boolean(trim(options.url) || trim(process.env.DSH_RPC_URL));
  const first = resolveConnection(options);
  try {
    return await attempt(first);
  } catch (error) {
    const code =
      error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;
    const isBadPort = code === "EBADPORT";
    if (explicit || ((!code || !RETRYABLE_CONNECT_CODES.has(code)) && !isBadPort)) throw error;
    const second = resolveConnection(options);
    if (second.url === first.url) {
      if (isBadPort) throw error;
      throw staleEndpointError(error, second);
    }
    try {
      return await attempt(second);
    } catch (again) {
      // Only a refused handshake means the *new* address is dead too. A 401, a
      // method error, a timeout, or another bad port is the real answer to the
      // request and must not be re-labelled as "nothing is listening".
      const againCode =
        again && typeof again === "object" && typeof (again as { code?: unknown }).code === "string"
          ? (again as { code: string }).code
          : undefined;
      if (againCode && RETRYABLE_CONNECT_CODES.has(againCode)) throw staleEndpointError(again, second);
      throw again;
    }
  }
}

/**
 * Single JSON-RPC call. Resolves to the method's `result` value so callers can
 * read fields directly; throws an Error carrying `code`/`data`/`status` on
 * failure.
 *
 * `options.timeoutMs` defaults to two minutes, which is right for every control
 * call. Long-running calls (`ask`, `wait`) pass a budget derived from the turn
 * timeout instead, so this default never cuts a legitimate turn short.
 */
export async function rpcCall<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  options: RpcCallOptions = {},
): Promise<T> {
  const budget = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  return withEndpointRetry(options, (connection) => performCall<T>(connection, method, params, options, budget));
}

/**
 * Default slice length. Mirrors the bridge's `maxWaitSliceMs` default, so a
 * caller that knows nothing about slicing still stays three minutes clear of
 * the 300 s transport ceiling.
 */
export const WAIT_SLICE_MS = 120_000;

/**
 * Wait for a turn to end, in slices.
 *
 * Node's built-in fetch aborts any request after 300 s (`headersTimeout`), so a
 * single patient wait never comes back: measured at 303.9 s against a live
 * bridge, with the turn still running and the answer thrown away. A long wait
 * therefore has to be a loop of short ones. The bridge reports its own slice
 * length as `sliceMs`, which a caller may pass back in.
 */
export async function waitForTurn(sessionId: string, options: WaitForTurnOptions = {}): Promise<WaitForTurnResult> {
  const budgetMs = Math.max(
    1_000,
    options.timeoutMs !== undefined && Number.isInteger(options.timeoutMs) ? options.timeoutMs : WAIT_SLICE_MS,
  );
  const sliceMs = Math.max(
    1_000,
    Math.min(
      options.sliceMs !== undefined && Number.isInteger(options.sliceMs) ? options.sliceMs : WAIT_SLICE_MS,
      budgetMs,
      MAX_WAIT_SLICE_MS,
    ),
  );
  const startedAt = Date.now();
  let last: Record<string, unknown> | null = null;
  let slices = 0;
  for (;;) {
    const left = budgetMs - (Date.now() - startedAt);
    const slice = Math.max(1_000, Math.min(sliceMs, left > 0 ? left : 1_000));
    const params: { sessionId: string; timeoutMs: number; since?: number } = { sessionId, timeoutMs: slice };
    if (options.since !== undefined && Number.isInteger(options.since)) params.since = options.since;
    // The transport budget stays under the 300 s ceiling no matter what the
    // caller's overall budget is; that is the whole point of slicing.
    last = await rpcCall<Record<string, unknown>>("dsh.sessions.wait", params, {
      ...options,
      timeoutMs: Math.min(slice + 30_000, 280_000),
    });
    slices += 1;
    if (last?.status !== "timeout") break;
    if (Date.now() - startedAt >= budgetMs) break;
  }
  return { ...(last ?? {}), slices, waitedMs: Date.now() - startedAt };
}

async function performCall<T>(
  { url, token }: ResolvedConnection,
  method: string,
  params: Record<string, unknown>,
  options: RpcCallOptions,
  budget: number,
): Promise<T> {
  let response: Response;
  const signal = requestSignal(budget, options.signal);
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ jsonrpc: "2.0", id: options.id ?? 1, method, params }),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (error) {
    throw transportError(error, `dsh-rpc ${method}`, { timeoutMs: budget });
  }

  const raw = await response.text();
  if (response.status === 401) {
    // Same numeric code the wire format uses, so callers can branch on it.
    throw rpcError(-32001, "dsh-rpc rejected the token (401). Check DSH_RPC_TOKEN or the token file.", undefined, 401);
  }
  if (response.status === 403) {
    throw rpcError(-32002, "dsh-rpc only serves loopback clients by default (enable allowRemote).", undefined, 403);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // The usual cause is that nothing is mounted at this path: the Web server
    // still answers, but with the SPA's index.html or an empty 404, and "Unexpected
    // token '<'" tells the caller nothing about the real problem.
    throw rpcError(
      -32000,
      `dsh-rpc: ${url} answered HTTP ${response.status} with a non-JSON body — ` +
        `the bridge is most likely not mounted (is the plugin enabled?). ` +
        `Body starts with: ${JSON.stringify(raw.slice(0, 120))}`,
      { status: response.status },
      response.status,
    );
  }
  if (!response.ok) {
    throw rpcError(
      -32000,
      `dsh-rpc ${method} returned HTTP ${response.status}: ${raw.slice(0, 400)}`,
      { status: response.status },
      response.status,
    );
  }
  const envelope = (payload && typeof payload === "object" ? payload : null) as {
    jsonrpc?: unknown;
    id?: unknown;
    result?: unknown;
    error?: { code?: unknown; message?: unknown; data?: unknown };
  } | null;
  const hasResult = Object.prototype.hasOwnProperty.call(payload ?? {}, "result");
  const hasError = Object.prototype.hasOwnProperty.call(payload ?? {}, "error");
  const errorValid =
    envelope?.error &&
    typeof envelope.error === "object" &&
    Number.isInteger(envelope.error.code) &&
    typeof envelope.error.message === "string";
  if (
    envelope?.jsonrpc !== "2.0" ||
    envelope.id !== (options.id ?? 1) ||
    hasResult === hasError ||
    (hasError && !errorValid)
  ) {
    throw rpcError(-32000, `dsh-rpc ${method} returned an invalid JSON-RPC response envelope`, undefined, response.status);
  }
  if (hasError) {
    const errObj = envelope!.error as { code: number; message: string; data?: unknown };
    throw rpcError(errObj.code, errObj.message, errObj.data, response.status);
  }
  return envelope!.result as T;
}

function rpcError(code: number, message: string, data?: unknown, status?: number): ClientRpcError {
  const error = new Error(message) as ClientRpcError;
  error.code = code;
  error.data = data;
  error.status = status;
  return error;
}

/**
 * Streaming call against `<rpc>/stream`: yields parsed NDJSON frames until the
 * connection closes. The final frame is `{type:"result"}` or `{type:"error"}`.
 */
export async function* rpcStream(
  params: Record<string, unknown> = {},
  options: RpcStreamOptions = {},
): AsyncGenerator<RpcStreamFrame, void, undefined> {
  const response = await withEndpointRetry(options, (connection) =>
    openStream(connection, params, options, options.timeoutMs ?? 0),
  );

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          yield JSON.parse(line) as RpcStreamFrame;
        } catch {
          yield { type: "malformed", line };
        }
      }
      newline = buffer.indexOf("\n");
    }
  }
  const tail = buffer.trim();
  if (tail.length > 0) {
    try {
      yield JSON.parse(tail) as RpcStreamFrame;
    } catch {
      yield { type: "malformed", line: tail };
    }
  }
}

/**
 * Open the streaming connection and reject non-2xx before any frame is read.
 * Split out of `rpcStream` so the retry wrapper only ever replays the handshake,
 * never a partially consumed stream.
 */
async function openStream(
  { url, token }: ResolvedConnection,
  params: Record<string, unknown>,
  options: RpcStreamOptions,
  budget: number,
): Promise<Response & { body: NonNullable<Response["body"]> }> {
  const target = `${url.replace(/\/+$/, "")}/stream`;
  let response: Response;
  const signal = requestSignal(budget, options.signal);
  try {
    response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(token) },
      body: JSON.stringify(params),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (error) {
    throw transportError(error, "dsh-rpc stream", { timeoutMs: budget });
  }

  if (response.status === 401) {
    throw rpcError(-32001, "dsh-rpc rejected the token (401). Check DSH_RPC_TOKEN or the token file.", undefined, 401);
  }
  if (response.status === 403) {
    throw rpcError(-32002, "dsh-rpc only serves loopback clients by default (enable allowRemote).", undefined, 403);
  }
  if (!response.ok) {
    const raw = await response.text();
    throw rpcError(
      -32000,
      `dsh-rpc stream returned HTTP ${response.status}: ${raw.slice(0, 400)}`,
      { status: response.status },
      response.status,
    );
  }
  if (!response.body) {
    throw new Error("dsh-rpc stream returned no body (this Node build lacks streaming fetch)");
  }
  return response as Response & { body: NonNullable<Response["body"]> };
}
