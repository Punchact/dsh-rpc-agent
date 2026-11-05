// Out-of-process client used by the CLI and the MCP bridge. Both run inside the
// *calling* agent's process, so they only speak HTTP to the Harness and never
// import Host modules.

import { endpointPath, readEndpoint, readTokenFromFile } from "./auth.mjs";
import { transportCode } from "./transport.mjs";

const DEFAULT_PATH = "/dsh-rpc";

export function resolveConnection(options = {}) {
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

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function authHeaders(token) {
  // One header only: sending the secret twice doubles the places a proxy or a
  // shell history can capture it for no benefit.
  return { authorization: `Bearer ${token}` };
}

/** A caller signal wins; otherwise an explicit budget becomes a timeout signal. */
function requestSignal(timeoutMs, callerSignal) {
  if (callerSignal) return callerSignal;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return AbortSignal.timeout(timeoutMs);
}

// The errno recovery lives in its own module so the platform differences can be
// tested directly, without a socket (see test/client.test.mjs).

/**
 * Keep the transport failure recognisable (`code`, `name`) while making the
 * message say what the caller was doing. `fetch` alone reports "fetch failed",
 * which is useless in a CLI transcript.
 */
function transportError(error, label, options) {
  const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
  const detail = timedOut
    ? `timed out${options.timeoutMs ? ` after ${options.timeoutMs}ms` : ""}`
    : (error?.message ?? String(error));
  const wrapped = new Error(`${label}: ${detail}`);
  wrapped.name = error?.name ?? "Error";
  wrapped.code = transportCode(error);
  wrapped.cause = error;
  return wrapped;
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000;

// Only a refused handshake is retried. ECONNREFUSED means the kernel answered
// SYN with RST and the request never left this process, so a retry cannot
// double-submit a prompt. ECONNRESET / EPIPE / timeouts mean bytes may already
// have been delivered and a turn may be running, so those are reported, never
// resent.
const RETRYABLE_CONNECT_CODES = new Set(["ECONNREFUSED"]);

function staleEndpointError(error, connection) {
  const endpoint = connection.endpoint;
  const published = endpoint?.updatedAt
    ? `last published ${endpoint.updatedAt}`
    : "no published endpoint, so the URL came from DSH_WEB_URL";
  const who = endpoint?.pid ? `pid ${endpoint.pid}, started ${endpoint.startedAt}` : "no pid recorded";
  const wrapped = new Error(
    `${error.message} — nothing is listening on ${connection.url} (${published}; ${who}). ` +
      "The Harness most likely restarted on a new port: run `dsh-rpc health --wait 15000` and retry, " +
      "or pass --url to override.",
  );
  wrapped.name = error.name ?? "Error";
  wrapped.code = error.code;
  wrapped.cause = error;
  return wrapped;
}

/**
 * Resolve the endpoint, run `attempt`, and — only if the socket was refused —
 * re-resolve and try once more.
 *
 * The Web server takes an OS-assigned port on every start (the Desktop launcher
 * asks for port 0), so a caller racing a restart can hold a port that was valid
 * a second ago. The plugin republishes the endpoint file on every start, so
 * re-reading it is what turns that race into a retry instead of a failure.
 * An explicitly supplied `--url` or `DSH_RPC_URL` is never retried: the caller
 * named the address, so the answer is the error, not another guess.
 */
async function withEndpointRetry(options, attempt) {
  const explicit = Boolean(trim(options.url) || trim(process.env.DSH_RPC_URL));
  const first = resolveConnection(options);
  try {
    return await attempt(first);
  } catch (error) {
    if (explicit || !RETRYABLE_CONNECT_CODES.has(error?.code)) throw error;
    const second = resolveConnection(options);
    if (second.url === first.url) throw staleEndpointError(error, second);
    try {
      return await attempt(second);
    } catch (again) {
      // Only a refused handshake means the *new* address is dead too. A 401, a
      // method error or a timeout is the real answer to the request and must not
      // be re-labelled as "nothing is listening".
      if (RETRYABLE_CONNECT_CODES.has(again?.code)) throw staleEndpointError(again, second);
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
export async function rpcCall(method, params = {}, options = {}) {
  const budget = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  return withEndpointRetry(options, (connection) => performCall(connection, method, params, options, budget));
}

async function performCall({ url, token }, method, params, options, budget) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ jsonrpc: "2.0", id: options.id ?? 1, method, params }),
      signal: requestSignal(budget, options.signal),
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
  let payload;
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
  if (payload?.error) {
    throw rpcError(
      payload.error.code,
      payload.error.message || "dsh-rpc error",
      payload.error.data,
      response.status,
    );
  }
  return payload?.result;
}

function rpcError(code, message, data, status) {
  const error = new Error(message);
  error.code = code;
  error.data = data;
  error.status = status;
  return error;
}

/**
 * Streaming call against `<rpc>/stream`: yields parsed NDJSON frames until the
 * connection closes. The final frame is `{type:"result"}` or `{type:"error"}`.
 */
export async function* rpcStream(params = {}, options = {}) {
  const response = await withEndpointRetry(options, (connection) =>
    openStream(connection, params, options, options.timeoutMs ?? 0),
  );

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          yield JSON.parse(line);
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
      yield JSON.parse(tail);
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
async function openStream({ url, token }, params, options, budget) {
  const target = `${url.replace(/\/+$/, "")}/stream`;
  let response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(token) },
      body: JSON.stringify(params),
      signal: requestSignal(budget, options.signal),
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
  return response;
}
