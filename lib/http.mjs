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

/**
 * Where the Settings page always looks for its status snapshot. The page is a
 * static browser module, so it cannot discover a reconfigured `path`; the route
 * is mounted here as well whenever the configured base differs.
 */
const STATUS_ALIAS = "/dsh-rpc/status";

/**
 * Path → trampoline cell. Held on `globalThis` under a symbol on purpose: the
 * Host re-imports this module on every reload, and a plain module-level Map
 * would forget which paths the previous generation mounted, so each reload would
 * collide with the previous one and never activate again.
 */
const ROUTE_CELLS = (globalThis[Symbol.for("dsh-rpc.route-cells")] ??= new Map());

export function buildDispatcher(methods) {
  const table = new Map([
    ["dsh.ping", (params) => methods.ping(params)],
    ["dsh.discover", (params) => methods.discover(params)],
    ["dsh.models", (params) => methods.models(params)],
    ["dsh.workspaces.list", (params) => methods.listWorkspaces(params)],
    ["dsh.workspaces.create", (params) => methods.createWorkspace(params)],
    ["dsh.permissions.catalog", (params) => methods.permissionCatalog(params)],
    ["dsh.sessions.list", (params) => methods.listSessions(params)],
    ["dsh.sessions.create", (params) => methods.createSession(params)],
    ["dsh.sessions.configure", (params) => methods.configure(params)],
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

export function registerRoutes({ webServer, config, dispatch, methods, state, ctx, log, stats }) {
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
    const startedAt = Date.now();
    // Record the label the caller used, not the aliased target: `ask` and
    // `dsh.sessions.ask` are the same work, and counting them apart is what a
    // reader of the status page expects to see.
    const label = typeof entry?.method === "string" ? entry.method : "?";
    try {
      assertRequest(entry);
      id = normalizeId(entry.id);
      notification = isNotification(entry);
      const params = paramsObject(entry.params);
      const result = await dispatch(entry.method, params);
      if (config.logRequests) log.info?.(`[dsh-rpc] ${entry.method} ok`);
      stats?.record?.(label, Date.now() - startedAt, true);
      return notification ? null : ok(id, result);
    } catch (error) {
      const described = describeError(error);
      if (config.logRequests || described.code !== CODE.methodNotFound) {
        log.warn?.(`[dsh-rpc] ${String(entry?.method ?? "?")} failed: ${described.message}`);
      }
      stats?.record?.(label, Date.now() - startedAt, false, described.code);
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

    const startedAt = Date.now();
    const label = "dsh.sessions.ask (stream)";
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
      stats?.record?.(label, Date.now() - startedAt, true);
    } catch (error) {
      const described = describeError(error);
      write({ type: "error", error: described });
      stats?.record?.(label, Date.now() - startedAt, false, described.code);
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

  // ---------------------------------------------------------------- status --

  /**
   * Loopback-only, token-free snapshot for the Settings page. Same trust
   * boundary as `/health` (you must already be on this machine), and the payload
   * is deliberately free of secrets and of anything a caller said: no token,
   * no prompt text, no session handle.
   */
  const statusHandler = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "use GET" }, { allow: "GET" });
      return;
    }
    if (!reachable(req)) {
      sendJson(res, 403, { ok: false, error: "loopback only" });
      return;
    }

    // `ping()` is the one method that reports the live run table; if it throws
    // the page should still render, so a failure degrades to nulls.
    let live = null;
    try {
      live = await methods.ping();
    } catch {
      live = null;
    }

    const body = {
      ok: true,
      plugin: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      origin: live?.origin ?? null,
      path: base,
      pid: live?.pid ?? process.pid,
      node: live?.node ?? process.version,
      startedAt: stats?.startedAt ? new Date(stats.startedAt).toISOString() : null,
      servedForMs: stats?.startedAt ? Date.now() - stats.startedAt : null,
      tokenSource: live?.state?.tokenSource ?? state?.tokenSource ?? "unknown",
      endpointPath: live?.state?.endpointPath ?? state?.endpointPath ?? null,
      config: live?.config ?? null,
      activeRuns: (live?.activeRuns ?? []).map(({ sessionId, runId, prompt, state: runState, ageMs }) => ({
        run: runId.slice(0, 8),
        prompt,
        state: runState ?? "running",
        ageMs,
        hasSession: typeof sessionId === "string" && sessionId.length > 0,
      })),
      calls: stats?.snapshot?.() ?? { total: 0, errors: 0, byMethod: {}, recent: [] },
      routes: { rpc: base, stream: `${base}/stream`, health: `${base}/health`, status: `${base}/status` },
    };
    sendJson(res, 200, body);
  };

  // Mounting is not free of failure modes: a route can already be taken by a
  // previous activation of this same plugin (a reload that threw after mounting,
  // or a teardown that raced the next activation), and `webServer` offers no
  // unregister other than the original disposer. So each path gets one stable
  // trampoline cell, owned by the newest instance that asked for it; older owners
  // lose their claim and their disposer leaves the route alone.
  const instanceId = Symbol("dsh-rpc routes");
  const mounted = [];

  const claim = (path, handler) => {
    const cell = ROUTE_CELLS.get(path);

    if (cell) {
      // Take over the existing trampoline. The adopting generation still gets a
      // disposer — it is the current owner, so it is the one that must be able
      // to unmount. Without this a reload would hand over a route that could
      // never be released again, and disabling the plugin would keep serving.
      cell.handler = handler;
      cell.owner = instanceId;
      disposers.push(() => {
        if (ROUTE_CELLS.get(path) !== cell || cell.owner !== instanceId) return;
        ROUTE_CELLS.delete(path);
        cell.release();
      });
      return;
    }

    const fresh = { handler, owner: instanceId, release: null };
    let dispose;
    try {
      dispose = webServer.register({
        kind: "exact",
        path,
        handler: (req, res) => fresh.handler(req, res),
      });
    } catch (error) {
      // Something that is not this plugin owns the path. Surface it as-is: a
      // silent skip would turn a real conflict into a bridge that answers 404s.
      throw new Error(`dsh-rpc cannot mount ${path}: ${error?.message ?? error}`);
    }

    fresh.release = dispose;
    ROUTE_CELLS.set(path, fresh);
    disposers.push(() => {
      if (ROUTE_CELLS.get(path) !== fresh || fresh.owner !== instanceId) return;
      ROUTE_CELLS.delete(path);
      fresh.release();
    });
  };

  const mount = (path, handler) => {
    claim(path, handler);
    mounted.push(path);
  };

  try {
    mount(base, rpcHandler);
    mount(`${base}/stream`, streamHandler);
    mount(`${base}/health`, healthHandler);
    const statusPath = `${base}/status`;
    mount(statusPath, statusHandler);

    // The Settings page is static browser code: it cannot read `endpoint.json`,
    // so it always asks the default path. A reconfigured `path` keeps this one
    // alias so the page still works.
    if (statusPath !== STATUS_ALIAS) mount(STATUS_ALIAS, statusHandler);
  } catch (error) {
    // All-or-nothing: a half-mounted bridge would answer some routes and 404
    // others while the row still reports a failed activation.
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // already gone
      }
    }
    throw error;
  }

  log.info?.(`[dsh-rpc] mounted ${mounted.join(", ")}`);

  return {
    paths: {
      rpc: base,
      stream: `${base}/stream`,
      health: `${base}/health`,
      status: `${base}/status`,
      statusAlias: STATUS_ALIAS,
    },
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
