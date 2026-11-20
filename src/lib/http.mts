// HTTP carrier for the RPC bridge. Routes are mounted on the Host's existing
// `webServer` service, so the bridge shares the Web UI origin and port — no
// second listener, no extra port to open, and the same loopback posture the GUI
// already has.

import { CODE, RpcError, assertRequest, describeError, failure, isNotification, normalizeId, ok, paramsObject } from "./protocol.mjs";
import { extractToken, tokenMatches } from "./auth.mjs";
import { PLUGIN_NAME, PLUGIN_VERSION, PROTOCOL_VERSION } from "./version.mjs";

export interface RpcDispatchContext {
  signal?: AbortSignal;
  clientAbort?: () => boolean;
  onEvent?: (frame: unknown) => void;
}

export interface PingActiveRun {
  sessionId?: string;
  runId: string;
  prompt?: unknown;
  state?: string;
  ageMs?: number;
}

export interface PingSnapshot {
  origin?: string | null;
  pid?: number;
  node?: string;
  state?: {
    tokenSource?: string;
    endpointPath?: string | null;
  };
  config?: unknown;
  activeRuns?: PingActiveRun[];
}

export interface CreatedSessionSnapshot {
  sessionId: string;
  cwd?: string | null;
  agentPreset?: string | null;
}

export type RpcHandler = (params: Record<string, unknown>, context: RpcDispatchContext) => unknown | Promise<unknown>;

export interface RpcMethodsTable {
  tasksEnabled?: boolean;
  ping: (params?: Record<string, unknown>) => PingSnapshot | Promise<PingSnapshot>;
  discover: (params: Record<string, unknown>) => unknown;
  capabilities: (params: Record<string, unknown>) => unknown;
  models: (params: Record<string, unknown>) => unknown;
  listWorkspaces: (params: Record<string, unknown>) => unknown;
  createWorkspace: (params: Record<string, unknown>) => unknown;
  permissionCatalog: (params: Record<string, unknown>) => unknown;
  approvalsPending: (params: Record<string, unknown>, context: RpcDispatchContext) => unknown;
  approvalsResolve: (params: Record<string, unknown>) => unknown;
  listSessions: (params: Record<string, unknown>) => unknown;
  createSession: (params: Record<string, unknown>) => CreatedSessionSnapshot | Promise<CreatedSessionSnapshot>;
  configure: (params: Record<string, unknown>) => unknown;
  ask: (params: Record<string, unknown>, context: RpcDispatchContext) => object | Promise<object>;
  prompt: (params: Record<string, unknown>) => unknown;
  wait: (params: Record<string, unknown>, context: RpcDispatchContext) => unknown;
  cancel: (params: Record<string, unknown>) => unknown;
  history: (params: Record<string, unknown>) => unknown;
  submitTask: (params: Record<string, unknown>) => unknown;
  getTask: (params: Record<string, unknown>) => unknown;
  listTasks: (params: Record<string, unknown>) => unknown;
  taskEvents: (params: Record<string, unknown>) => unknown;
  inputTask: (params: Record<string, unknown>) => unknown;
  readArtifactTask: (params: Record<string, unknown>) => unknown;
  getAgent: (params: Record<string, unknown>) => unknown;
  cancelTask: (params: Record<string, unknown>) => unknown;
  previewTask: (params: Record<string, unknown>) => unknown;
  reconcileTask: (params: Record<string, unknown>) => unknown;
  dispatchTask: (params: Record<string, unknown>) => unknown;
  pumpTask: (params: Record<string, unknown>) => unknown;
  decideApprovalTask: (params: Record<string, unknown>) => unknown;
  resolveTask: (params: Record<string, unknown>) => unknown;
  registerAgent: (params: Record<string, unknown>) => unknown;
  listAgents: (params: Record<string, unknown>) => unknown;
  probeAgent: (params: Record<string, unknown>) => unknown;
}

export type RpcDispatcher = (
  method: string,
  params: Record<string, unknown>,
  context?: RpcDispatchContext,
) => Promise<unknown>;

export interface HttpRequestLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string } | null;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "aborted", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  destroy(): unknown;
}

export interface HttpResponseLike {
  writableEnded?: boolean;
  destroyed?: boolean;
  on?: (event: "close", listener: () => void) => unknown;
  writeHead(status: number, headers?: Record<string, string | number>): { end(body?: string): unknown };
  write(chunk: string): unknown;
  end(body?: string): unknown;
}

export type HttpRouteHandler = (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>;

export interface WebServerLike {
  register(route: { kind: "exact"; path: string; handler: HttpRouteHandler }): () => void;
}

export interface HttpConfigLike {
  path: string;
  allowRemote?: boolean | undefined;
  maxBodyBytes: number;
  logRequests?: boolean | undefined;
}

export interface HttpStateLike {
  token: string;
  tokenSource?: string;
  endpointPath?: string | null;
}

export interface HttpLoggerLike {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface HttpStatsLike {
  startedAt?: number | null;
  record?: (
    method: string,
    durationMs: number,
    ok: boolean,
    errorCode?: number | null,
    outcome?: string | null,
  ) => void;
  snapshot?: () => {
    total: number;
    errors: number;
    byMethod: Record<string, unknown>;
    recent: unknown[];
  };
}

export interface RegisterRoutesOptions {
  webServer: WebServerLike;
  config: HttpConfigLike;
  dispatch: RpcDispatcher;
  methods: RpcMethodsTable;
  state: HttpStateLike;
  ctx?: unknown;
  log: HttpLoggerLike;
  stats?: HttpStatsLike;
}

export interface RegisteredRoutes {
  paths: {
    rpc: string;
    stream: string;
    health: string;
    status: string;
    statusAlias: string;
  };
  dispose(): void;
}

interface RouteCell {
  handler: HttpRouteHandler;
  owner: symbol;
  release: (() => void) | null;
}

const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

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
const ROUTE_CELLS_KEY = Symbol.for("dsh-rpc.route-cells");
const globalStore = globalThis as Record<PropertyKey, unknown>;
const ROUTE_CELLS = (globalStore[ROUTE_CELLS_KEY] ??= new Map<string, RouteCell>()) as Map<string, RouteCell>;

export function buildDispatcher(methods: RpcMethodsTable): RpcDispatcher {
  // A disabled task centre must look absent rather than half-alive: the carrier
  // answers -32601 for the whole family, so a caller falls back to "this plugin
  // has no task centre" instead of submitting work nobody will ever read.
  const gateTask = (handler: RpcHandler): RpcHandler => (params, context) => {
    if (!methods.tasksEnabled) {
      throw new RpcError(
        CODE.methodNotFound,
        "this plugin runs with tasksEnabled=false; the task centre is off (circuit breaker)",
        { kind: "METHOD_NOT_FOUND", reason: "tasks_disabled" },
      );
    }
    return handler(params, context);
  };

  const table = new Map<string, RpcHandler>([
    ["dsh.ping", (params) => methods.ping(params)],
    ["dsh.discover", (params) => methods.discover(params)],
    ["dsh.capabilities", (params) => methods.capabilities(params)],
    ["dsh.models", (params) => methods.models(params)],
    ["dsh.workspaces.list", (params) => methods.listWorkspaces(params)],
    ["dsh.workspaces.create", (params) => methods.createWorkspace(params)],
    ["dsh.permissions.catalog", (params) => methods.permissionCatalog(params)],
    ["dsh.approvals.pending", (params, context) => methods.approvalsPending(params, context)],
    ["dsh.approvals.resolve", (params) => methods.approvalsResolve(params)],
    ["dsh.sessions.list", (params) => methods.listSessions(params)],
    ["dsh.sessions.create", (params) => methods.createSession(params)],
    ["dsh.sessions.configure", (params) => methods.configure(params)],
    ["dsh.sessions.ask", (params, context) => methods.ask(params, context)],
    ["dsh.sessions.prompt", (params) => methods.prompt(params)],
    ["dsh.sessions.wait", (params, context) => methods.wait(params, context)],
    ["dsh.sessions.cancel", (params) => methods.cancel(params)],
    ["dsh.sessions.history", (params) => methods.history(params)],
    ["dsh.tasks.submit", gateTask((params) => methods.submitTask(params))],
    ["dsh.tasks.get", gateTask((params) => methods.getTask(params))],
    ["dsh.tasks.list", gateTask((params) => methods.listTasks(params))],
    ["dsh.tasks.events", gateTask((params) => methods.taskEvents(params))],
    ["dsh.tasks.input", gateTask((params) => methods.inputTask(params))],
    ["dsh.tasks.readArtifact", gateTask((params) => methods.readArtifactTask(params))],
    ["dsh.agents.get", gateTask((params) => methods.getAgent(params))],
    ["dsh.tasks.cancel", gateTask((params) => methods.cancelTask(params))],
    ["dsh.tasks.preview", gateTask((params) => methods.previewTask(params))],
    ["dsh.tasks.reconcile", gateTask((params) => methods.reconcileTask(params))],
    ["dsh.tasks.dispatch", gateTask((params) => methods.dispatchTask(params))],
    ["dsh.tasks.pump", gateTask((params) => methods.pumpTask(params))],
    ["dsh.tasks.decideApproval", gateTask((params) => methods.decideApprovalTask(params))],
    ["dsh.tasks.resolve", gateTask((params) => methods.resolveTask(params))],
    ["dsh.agents.register", gateTask((params) => methods.registerAgent(params))],
    ["dsh.agents.list", gateTask((params) => methods.listAgents(params))],
    ["dsh.agents.probe", gateTask((params) => methods.probeAgent(params))],
  ]);

  // Friendly aliases keep hand-written curl calls short without a second
  // contract to maintain.
  const aliases = new Map<string, string>([
    ["ping", "dsh.ping"],
    ["discover", "dsh.discover"],
    ["ask", "dsh.sessions.ask"],
    ["models", "dsh.models"],
  ]);

  return async function dispatch(method, params, context = {}) {
    const name = aliases.get(method) ?? method;
    const handler = table.get(name);
    if (!handler) {
      throw new RpcError(CODE.methodNotFound, `unknown method: ${method}`, {
        available: [...table.keys()].sort(),
      });
    }
    return handler(params, context);
  };
}

export function registerRoutes({ webServer, config, dispatch, methods, state, ctx: _ctx, log, stats }: RegisterRoutesOptions): RegisteredRoutes {
  const base = config.path;
  const disposers: Array<() => void> = [];

  const authorized = (req: HttpRequestLike): boolean => tokenMatches(state.token, extractToken(req.headers));

  const reachable = (req: HttpRequestLike): boolean => {
    if (config.allowRemote) return true;
    const address = req.socket?.remoteAddress ?? "";
    return LOOPBACK_ADDRESSES.has(address);
  };

  const guard = (req: HttpRequestLike, res: HttpResponseLike): boolean => {
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

  const rpcHandler: HttpRouteHandler = async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, failure(null, CODE.invalidRequest, "use POST for JSON-RPC"), { allow: "POST" });
      return;
    }
    if (!guard(req, res)) return;

    // A caller that hangs up must not leave us working. Aborting stops the event
    // iterator and frees the slot; it is NOT a cancel — the turn keeps running in
    // the Host and can still be collected with `wait`.
    const abort = new AbortController();
    let clientGone = false;
    res.on?.("close", () => {
      if (!res.writableEnded) {
        clientGone = true;
        abort.abort();
      }
    });
    const rpcContext: RpcDispatchContext = { signal: abort.signal, clientAbort: () => clientGone };

    let body: string;
    try {
      body = await readBody(req, config.maxBodyBytes);
    } catch (error) {
      const tooLarge = error instanceof RpcError;
      const message =
        error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "unreadable body";
      sendJson(
        res,
        tooLarge ? 413 : 400,
        failure(null, CODE.invalidRequest, message, tooLarge ? error.data : undefined),
        tooLarge ? { connection: "close" } : {},
      );
      return;
    }

    let payload: unknown;
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
      const answers: unknown[] = [];
      for (const entry of payload) {
        // Once the caller has hung up there is nobody left to answer, so stop
        // dispatching instead of finishing a batch for a closed socket. Members
        // that already ran keep their effects; the rest never start.
        if (rpcContext.signal!.aborted) break;
        const answer = await handleOne(entry, rpcContext);
        if (answer !== null) answers.push(answer);
      }
      if (rpcContext.signal!.aborted) return;
      if (answers.length === 0) {
        if (!res.destroyed && !res.writableEnded) res.writeHead(204).end();
        return;
      }
      sendJson(res, 200, answers);
      return;
    }

    const answer = await handleOne(payload, rpcContext);
    if (res.destroyed || res.writableEnded) return;
    if (answer === null) {
      res.writeHead(204).end();
      return;
    }
    sendJson(res, 200, answer);
  };

  const handleOne = async (entry: unknown, context: RpcDispatchContext = {}) => {
    let id: string | number | null = null;
    let notification = false;
    const startedAt = Date.now();
    // Record the label the caller used, not the aliased target: `ask` and
    // `dsh.sessions.ask` are the same work, and counting them apart is what a
    // reader of the status page expects to see.
    const rawMethod = entry && typeof entry === "object" ? (entry as { method?: unknown }).method : undefined;
    const label = typeof rawMethod === "string" ? rawMethod : "?";
    try {
      assertRequest(entry);
      id = normalizeId(entry.id);
      notification = isNotification(entry);
      const params = paramsObject(entry.params);
      const result = await dispatch(entry.method, params, context);
      if (config.logRequests) log.info?.(`[dsh-rpc] ${entry.method} ok`);
      const timedOut =
        result && typeof result === "object" && (result as { timedOut?: unknown }).timedOut === true;
      stats?.record?.(label, Date.now() - startedAt, true, null, timedOut ? "timeouts" : null);
      return notification ? null : ok(id, result);
    } catch (error) {
      const described = describeError(error);
      if (config.logRequests || described.code !== CODE.methodNotFound) {
        log.warn?.(`[dsh-rpc] ${String(rawMethod ?? "?")} failed: ${described.message}`);
      }
      // A caller that hung up is not a failure of the bridge: the call was
      // admitted, did what it could and nobody is left to read the answer. It is
      // recorded as a *successful* call with the `cancelledByClient` outcome, so
      // error counters and error rate stay about the bridge's own mistakes.
      const abortedByClient = context?.clientAbort?.() === true;
      stats?.record?.(
        label,
        Date.now() - startedAt,
        abortedByClient,
        abortedByClient ? null : described.code,
        abortedByClient ? "cancelledByClient" : null,
      );
      return notification ? null : failure(id, described.code, described.message, described.data);
    }
  };

  // ------------------------------------------------------- streaming ask --

  const streamHandler: HttpRouteHandler = async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, failure(null, CODE.invalidRequest, "use POST"), { allow: "POST" });
      return;
    }
    if (!guard(req, res)) return;

    let params: Record<string, unknown>;
    try {
      const body = await readBody(req, config.maxBodyBytes);
      const parsed: unknown = body.trim().length === 0 ? {} : JSON.parse(body);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("body must be a JSON object of `dsh.sessions.ask` params");
      }
      params = parsed as Record<string, unknown>;
    } catch (error) {
      const tooLarge = error instanceof RpcError;
      const message =
        error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "invalid body";
      sendJson(
        res,
        tooLarge ? 413 : 400,
        failure(null, CODE.invalidParams, message),
        tooLarge ? { connection: "close" } : {},
      );
      return;
    }

    const abort = new AbortController();
    res.on?.("close", () => {
      if (!res.writableEnded) abort.abort(Object.assign(new Error("client disconnected"), { name: "AbortError" }));
    });

    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-dsh-rpc-version": PLUGIN_VERSION,
    });

    const write = (value: unknown): void => {
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

  const healthHandler: HttpRouteHandler = (req, res) => {
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
  const statusHandler: HttpRouteHandler = async (req, res) => {
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
    let live: PingSnapshot | null = null;
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
  const mounted: string[] = [];

  const claim = (path: string, handler: HttpRouteHandler): void => {
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
        cell.release?.();
      });
      return;
    }

    const fresh: RouteCell = { handler, owner: instanceId, release: null };
    let dispose: () => void;
    try {
      dispose = webServer.register({
        kind: "exact",
        path,
        handler: (req, res) => fresh.handler(req, res),
      });
    } catch (error) {
      // Something that is not this plugin owns the path. Surface it as-is: a
      // silent skip would turn a real conflict into a bridge that answers 404s.
      const msg =
        error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : String(error);
      throw new Error(`dsh-rpc cannot mount ${path}: ${msg}`);
    }

    fresh.release = dispose;
    ROUTE_CELLS.set(path, fresh);
    disposers.push(() => {
      if (ROUTE_CELLS.get(path) !== fresh || fresh.owner !== instanceId) return;
      ROUTE_CELLS.delete(path);
      fresh.release?.();
    });
  };

  const mount = (path: string, handler: HttpRouteHandler): void => {
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

function sendJson(
  res: HttpResponseLike,
  status: number,
  payload: unknown,
  headers: Record<string, string | number> = {},
): void {
  // The caller may already be gone. Writing to a destroyed socket throws, and a
  // second write would append a body to a finished response — either way the
  // catch in the route handler turns it into noise nobody can read.
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function readBody(req: HttpRequestLike, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    let settled = false;
    const chunks: Buffer[] = [];

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const tooLarge = () =>
      new RpcError(CODE.invalidRequest, `request body exceeds ${maxBytes} bytes`, { limit: maxBytes });

    req.on("data", (chunk: Buffer) => {
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
    req.on("error", (error: Error) => fail(error));
    req.on("aborted", () => fail(Object.assign(new Error("client aborted"), { name: "AbortError" })));
  });
}
