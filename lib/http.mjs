// HTTP carrier for the RPC bridge. Routes are mounted on the Host's existing
// `webServer` service, so the bridge shares the Web UI origin and port — no
// second listener, no extra port to open, and the same loopback posture the GUI
// already has.

import { CODE, RpcError, assertRequest, describeError, failure, isNotification, normalizeId, ok, paramsObject } from "./protocol.mjs";
import { extractToken, tokenMatches } from "./auth.mjs";
import { PLUGIN_NAME, PLUGIN_VERSION, PROTOCOL_VERSION } from "./version.mjs";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * How far past `maxBodyBytes` a body may run before the socket is cut instead of
 * drained. Draining lets the client finish writing and read a real 413; the cap
 * keeps an unbounded upload from being read forever.
 */
const OVERFLOW_DRAIN_FACTOR = 4;

export function buildDispatcher(methods) {
  const table = new Map([
    ["dsh.ping", (params) => methods.ping(params)],
    ["dsh.discover", (params) => methods.discover(params)],
    ["dsh.models", (params) => methods.models(params)],
    ["dsh.sessions.list", (params) => methods.listSessions(params)],
    ["dsh.sessions.create", (params) => methods.createSession(params)],
    ["dsh.sessions.ask", (params) => methods.ask(params)],
    ["dsh.sessions.prompt", (params) => methods.prompt(params)],
    ["dsh.sessions.wait", (params) => methods.wait(params)],
    ["dsh.sessions.cancel", (params) => methods.cancel(params)],
    ["dsh.sessions.history", (params) => methods.history(params)],
  ]);

  // Friendly aliases keep hand-written curl calls short without a second
  // contract to maintain.
  const aliases = new Map([
    ["ping", "dsh.ping"],
    ["discover", "dsh.discover"],
    ["ask", "dsh.sessions.ask"],
    ["models", "dsh.models"],
  ]);

  return async function dispatch(method, params) {
    const name = aliases.get(method) ?? method;
    const handler = table.get(name);
    if (!handler) {
      throw new RpcError(CODE.methodNotFound, `unknown method: ${method}`, {
        available: [...table.keys()].sort(),
      });
    }
    return handler(params);
  };
}

export function registerRoutes({ webServer, config, dispatch, methods, state, ctx, log }) {
  const base = config.path;
  const disposers = [];

  const authorized = (req) => tokenMatches(state.token, extractToken(req.headers));

  const reachable = (req) => {
    if (config.allowRemote) return true;
    const address = req.socket?.remoteAddress ?? "";
    return LOOPBACK_ADDRESSES.has(address);
  };

  const guard = (req, res) => {
    if (!reachable(req)) {
      sendJson(res, 403, failure(null, CODE.forbidden, "dsh-rpc accepts loopback connections only (set allowRemote to opt in)"));
      return false;
    }
    if (!authorized(req)) {
      sendJson(
        res,
        401,
        failure(null, CODE.unauthorized, "missing or invalid bearer token"),
        { "www-authenticate": 'Bearer realm="dsh-rpc"' },
      );
      return false;
    }
    return true;
  };

  // ------------------------------------------------------------- JSON-RPC --

  const rpcHandler = async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, failure(null, CODE.invalidRequest, "use POST for JSON-RPC"), { allow: "POST" });
      return;
    }
    if (!guard(req, res)) return;

    let body;
    try {
      body = await readBody(req, config.maxBodyBytes);
    } catch (error) {
      const tooLarge = error instanceof RpcError;
      sendJson(
        res,
        tooLarge ? 413 : 400,
        failure(null, CODE.invalidRequest, error?.message ?? "unreadable body", tooLarge ? error.data : undefined),
        tooLarge ? { connection: "close" } : {},
      );
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      sendJson(res, 400, failure(null, CODE.parseError, "request body is not valid JSON"));
      return;
    }

    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        sendJson(res, 400, failure(null, CODE.invalidRequest, "empty batch"));
        return;
      }
      const answers = [];
      for (const entry of payload) {
        const answer = await handleOne(entry);
        if (answer !== null) answers.push(answer);
      }
      if (answers.length === 0) {
        res.writeHead(204).end();
        return;
      }
      sendJson(res, 200, answers);
      return;
    }

    const answer = await handleOne(payload);
    if (answer === null) {
      res.writeHead(204).end();
      return;
    }
    sendJson(res, 200, answer);
  };

  const handleOne = async (entry) => {
    let id = null;
    let notification = false;
    try {
      assertRequest(entry);
      id = normalizeId(entry.id);
      notification = isNotification(entry);
      const params = paramsObject(entry.params);
      const result = await dispatch(entry.method, params);
      if (config.logRequests) log.info?.(`[dsh-rpc] ${entry.method} ok`);
      return notification ? null : ok(id, result);
    } catch (error) {
      const described = describeError(error);
      if (config.logRequests || described.code !== CODE.methodNotFound) {
        log.warn?.(`[dsh-rpc] ${String(entry?.method ?? "?")} failed: ${described.message}`);
      }
      return notification ? null : failure(id, described.code, described.message, described.data);
    }
  };

  // ------------------------------------------------------- streaming ask --

  const streamHandler = async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, failure(null, CODE.invalidRequest, "use POST"), { allow: "POST" });
      return;
    }
    if (!guard(req, res)) return;

    let params;
    try {
      const body = await readBody(req, config.maxBodyBytes);
      params = body.trim().length === 0 ? {} : JSON.parse(body);
      if (params === null || typeof params !== "object" || Array.isArray(params)) {
        throw new Error("body must be a JSON object of `dsh.sessions.ask` params");
      }
    } catch (error) {
      const tooLarge = error instanceof RpcError;
      sendJson(
        res,
        tooLarge ? 413 : 400,
        failure(null, CODE.invalidParams, error?.message ?? "invalid body"),
        tooLarge ? { connection: "close" } : {},
      );
      return;
    }

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort(Object.assign(new Error("client disconnected"), { name: "AbortError" }));
    });

    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-dsh-rpc-version": PLUGIN_VERSION,
    });

    const write = (value) => {
      if (res.writableEnded || abort.signal.aborted) return;
      try {
        res.write(`${JSON.stringify(value)}\n`);
      } catch {
        abort.abort();
      }
    };

    try {
      let sessionId = typeof params.sessionId === "string" && params.sessionId.trim() ? params.sessionId.trim() : "";
      let created = false;
      if (!sessionId) {
        const session = await methods.createSession(params);
        sessionId = session.sessionId;
        created = true;
        write({ type: "session", sessionId, cwd: session.cwd, agentPreset: session.agentPreset ?? null });
      }
      const result = await methods.ask(
        { ...params, sessionId },
        {
          signal: abort.signal,
          onEvent: (frame) => write({ type: "progress", frame }),
        },
      );
      write({ type: "result", ...result, created });
    } catch (error) {
      write({ type: "error", error: describeError(error) });
    } finally {
      try {
        res.end();
      } catch {
        // socket already gone
      }
    }
  };

  // ---------------------------------------------------------------- health --

  const healthHandler = (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "use GET" }, { allow: "GET" });
      return;
    }
    if (!reachable(req)) {
      sendJson(res, 403, { ok: false, error: "loopback only" });
      return;
    }
    const body = {
      ok: true,
      plugin: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      authenticated: tokenMatches(state.token, extractToken(req.headers)),
    };
    sendJson(res, 200, body);
  };

  const mount = (path, handler, kind = "exact") => {
    const dispose = webServer.register({ kind, path, handler });
    disposers.push(dispose);
    return dispose;
  };

  mount(base, rpcHandler);
  mount(`${base}/stream`, streamHandler);
  mount(`${base}/health`, healthHandler);

  log.info?.(`[dsh-rpc] mounted ${base} (+ /stream, /health)`);

  return {
    paths: { rpc: base, stream: `${base}/stream`, health: `${base}/health` },
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // a disposed webserver route is already gone
        }
      }
    },
  };
}

// --------------------------------------------------------------- utilities --

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    let settled = false;
    const chunks = [];

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const tooLarge = () =>
      new RpcError(CODE.invalidRequest, `request body exceeds ${maxBytes} bytes`, { limit: maxBytes });

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (overflow) {
        // Keep draining a moderately oversized body so the client finishes its
        // upload and can read the 413; an absurd one is cut off instead of
        // being buffered or read forever.
        if (size > maxBytes * OVERFLOW_DRAIN_FACTOR) {
          fail(tooLarge());
          req.destroy();
        }
        return;
      }
      if (size > maxBytes) {
        overflow = true;
        chunks.length = 0; // the partial buffer is useless now
        if (size > maxBytes * OVERFLOW_DRAIN_FACTOR) {
          fail(tooLarge());
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (overflow) reject(tooLarge());
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => fail(error));
    req.on("aborted", () => fail(Object.assign(new Error("client aborted"), { name: "AbortError" })));
  });
}
