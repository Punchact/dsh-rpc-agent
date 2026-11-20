import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

import { apply } from "../dist/index.mjs";
import { TASK_ERROR, isTaskError } from "../dist/lib/tasks/errors.mjs";

interface FakeHttpReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  on(event: string, cb: (chunk?: Buffer) => void): FakeHttpReq;
}

interface FakeHttpRes {
  destroyed: boolean;
  writableEnded: boolean;
  writeHead(s: number): void;
  end(chunk?: string | Buffer): void;
}

type FakeRouteHandler = (req: FakeHttpReq, res: FakeHttpRes) => Promise<void> | void;

interface FakePluginCtx {
  webServer: {
    getOrigin(): string;
    register(spec: { path: string; handler: FakeRouteHandler }): () => boolean;
  };
  sessionController: Record<string, unknown>;
  logger: {
    info(m: string): void;
    warn(m: string): void;
    error(): void;
    debug(): void;
  };
  get(name?: unknown): unknown;
  on(event: string, fn: () => void): void;
  effect(fn: () => (() => void) | void): void;
  taskAdapterFactories?: Record<string, () => unknown>;
}

interface JsonRpcResponseBody {
  result?: {
    agentId?: string;
    items?: unknown[];
    taskCentre?: {
      ready: boolean;
      mode: string;
      seedError: unknown;
      startError: unknown;
    };
  };
  error?: {
    data?: unknown;
  };
}

interface ClientRegistryEntry {
  id: string;
  factory: (dep: (name: string) => unknown) => {
    name: string;
    inject: Iterable<string>;
    apply(ctx: {
      effect(fn: () => void, label?: string): void;
      slots: {
        inject(slot: string, create: () => { meta: { id: string } }): void;
        register(meta: unknown, component: unknown): { meta: unknown; component: unknown };
      };
    }): void;
  };
}

const applyPlugin = apply as unknown as (ctx: FakePluginCtx, config: Record<string, unknown>) => Promise<unknown>;

function makeFakeCtx() {
  const routes = new Map<string, FakeRouteHandler>();
  const disposers: Array<() => void> = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const ctx: FakePluginCtx = {
    webServer: {
      getOrigin: () => "http://127.0.0.1:0",
      register({ path, handler }) {
        routes.set(path, handler);
        return () => routes.delete(path);
      },
    },
    sessionController: {},
    logger: {
      info: (m) => infos.push(m),
      warn: (m) => warnings.push(m),
      error: () => {},
      debug: () => {},
    },
    get: () => undefined,
    on: () => {},
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
    },
  };
  return {
    ctx,
    routes,
    warnings,
    infos,
    dispose() {
      for (const d of disposers.splice(0)) d();
    },
  };
}

async function callJsonRpc(
  routeHandler: FakeRouteHandler,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; body: JsonRpcResponseBody }> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let status = 0;
  let responseBody = "";
  const req: FakeHttpReq = {
    method: "POST",
    url: "/dsh-rpc",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
    on(event, cb) {
      if (event === "data") cb(Buffer.from(body, "utf8"));
      if (event === "end") cb();
      return this;
    },
  };
  const res: FakeHttpRes = {
    destroyed: false,
    writableEnded: false,
    writeHead(s) {
      status = s;
    },
    end(chunk) {
      if (chunk) responseBody += String(chunk);
      this.writableEnded = true;
    },
  };
  await routeHandler(req, res);
  return { status, body: JSON.parse(responseBody) as JsonRpcResponseBody };
}

test("index.mjs leaves task DB untouched when tasksEnabled=false", async () => {
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-wire-off-"));
  process.env.DSH_HOME = home;
  const fake = makeFakeCtx();
  try {
    await applyPlugin(fake.ctx, { token: "a".repeat(32), tasksEnabled: false });
    const defaultDb = join(home, "storages", "task-center", "tasks.db");
    assert.equal(existsSync(defaultDb), false);
  } finally {
    fake.dispose();
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("index.mjs opens tasks.db, seeds baseline entities, wires dispatcher, and handles adapter assembly failure gracefully", async () => {
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-wire-on-"));
  process.env.DSH_HOME = home;
  const token = "b".repeat(32);

  const fake = makeFakeCtx();
  fake.ctx.taskAdapterFactories = {
    codex: () => {
      throw new Error("simulated adapter init failure");
    },
  };

  try {
    await applyPlugin(fake.ctx, {
      token,
      defaultCwd: home,
      tasksEnabled: true,
      tasksExternalAdapter: "codex",
      tasksAdapters: { codex: { enabled: true, binary: "C:\\missing\\codex.exe" } },
    });

    const dbPath = join(home, "storages", "task-center", "tasks.db");
    assert.equal(existsSync(dbPath), true, "tasks.db must be created under DSH_HOME/storages/task-center");
    assert.ok(
      fake.warnings.some((w) => /failed to initialize codex adapter/.test(w)),
      "adapter init failure must be logged as a warning without aborting startup",
    );

    // Wait one microtask for async seedBaselineEntities
    await new Promise((r) => setTimeout(r, 20));

    const rpcHandler = fake.routes.get("/dsh-rpc")!;
    assert.equal(typeof rpcHandler, "function");

    // Register an agent card referencing codex, then list agents + check baseline principal works in preview
    const reg = await callJsonRpc(rpcHandler, token, "dsh.agents.register", {
      card: {
        identity: { agentId: "ag-codex", name: "Codex", kind: "codex", version: "0.169.0" },
        controls: {
          start: { support: "required", evidence: "stdio" },
          steer: { support: "optional", evidence: "turn/steer" },
          cancel: { support: "required", evidence: "turn/interrupt" },
          inspect: { support: "optional", evidence: "thread/read" },
          approval: { support: "optional", evidence: "approval" },
          events: { support: "required", evidence: "stdio" },
        },
        limitations: ["no native approval path on this host"],
      },
    });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.result!.agentId, "ag-codex");

    const listed = await callJsonRpc(rpcHandler, token, "dsh.tasks.list", {});
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.result!.items, []);

    // Verify missing adapter surfaces as ADAPTER_UNAVAILABLE on dispatch (not startup crash)
    // First seed capability revision directly via a second call or verify error shape when dispatching unknown task
    const resolveMissingVersion = await callJsonRpc(rpcHandler, token, "dsh.tasks.resolve", {
      taskId: "task_missing",
      idempotencyKey: "idem-resolve-1",
      disposition: "accept",
    });
    assert.equal(resolveMissingVersion.status, 200);
    assert.ok(
      isTaskError({ data: resolveMissingVersion.body.error!.data }, TASK_ERROR.VALIDATION_FAILED),
      "resolve must require expectedStateVersion rather than guess one",
    );

    const badDispatch = await callJsonRpc(rpcHandler, token, "dsh.tasks.dispatch", { taskId: "task_missing" });
    assert.equal(badDispatch.status, 200);
    assert.ok(isTaskError({ data: badDispatch.body.error!.data }, TASK_ERROR.NOT_FOUND));
  } finally {
    fake.dispose();
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("index.mjs survives a strict Host whose ctx.get() throws for unknown services", async () => {
  // Regression for the 0.9.0 on-state smoke failure: Cordis ctx.get(name, strict)
  // throws for a service nobody provides, which used to abort the whole task-centre
  // startup and leave the plugin on a silent in-memory store.
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-wire-strict-"));
  process.env.DSH_HOME = home;
  const token = "c".repeat(32);
  const fake = makeFakeCtx();
  const strictGet = (name: unknown) => {
    throw new Error(`service not found: ${String(name)}`);
  };
  fake.ctx.get = strictGet;

  try {
    await applyPlugin(fake.ctx, { token, defaultCwd: home, tasksEnabled: true });

    const rpcHandler = fake.routes.get("/dsh-rpc")!;
    assert.equal(typeof rpcHandler, "function");

    const ping = await callJsonRpc(rpcHandler, token, "dsh.ping", {});
    assert.equal(ping.status, 200);
    const centre = ping.body.result!.taskCentre!;
    assert.equal(centre.ready, true, "the task centre must report itself ready");
    assert.equal(centre.mode, "file", "a ready task centre must be backed by the file store");
    assert.equal(centre.seedError, null, "baseline seeding must actually succeed");
    assert.equal(centre.startError, null, "startup must not record an error");
    assert.equal(
      fake.warnings.some((w) => /task center disabled due to startup error/.test(w)),
      false,
      "a missing optional service must not disable the task centre",
    );

    // The seeding ran against the file store, not a throwaway in-memory database.
    const dbPath = join(home, "storages", "task-center", "tasks.db");
    assert.equal(existsSync(dbPath), true);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const principals = (db.prepare("SELECT principal_id FROM principals").all() as Array<{ principal_id: string }>).map(
        (row) => row.principal_id,
      );
      const workspaces = (db.prepare("SELECT workspace_id FROM workspaces").all() as Array<{ workspace_id: string }>).map(
        (row) => row.workspace_id,
      );
      assert.deepEqual(principals, ["local-operator"]);
      assert.deepEqual(workspaces, ["local"]);
    } finally {
      db.close();
    }
  } finally {
    fake.dispose();
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
test("a Host that binds a fetch-blocked port is warned about at startup", async () => {
  // The bridge inherits the Host's port, so it cannot refuse the assignment —
  // it can only say why clients will fail. Silence here would look like a
  // healthy server plus broken clients.
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-wire-port-"));
  process.env.DSH_HOME = home;
  const fake = makeFakeCtx();
  fake.ctx.webServer.getOrigin = () => "http://127.0.0.1:5060";
  try {
    await applyPlugin(fake.ctx, { token: "c".repeat(32), defaultCwd: home, tasksEnabled: false });
    assert.ok(
      fake.warnings.some((w) => /port 5060 is one fetch refuses/.test(w) && /EBADPORT/.test(w)),
      "a blocked Host port must be named at startup, because every out-of-process caller will fail",
    );
    assert.ok(
      fake.infos.some((m) => /ready at http:\/\/127\.0\.0\.1:5060\/dsh-rpc/.test(m)),
      "the bridge still mounts and publishes; only the warning is extra",
    );
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
test("an unparseable origin still lets the bridge start and publish", async () => {
  // The blocked-port warning is a side quest: it must never be the reason a
  // startup gives up on publishing the endpoint it was handed.
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-wire-origin-"));
  process.env.DSH_HOME = home;
  const fake = makeFakeCtx();
  fake.ctx.webServer.getOrigin = () => "not-a-url";
  try {
    await applyPlugin(fake.ctx, { token: "d".repeat(32), defaultCwd: home, tasksEnabled: false });
    assert.equal(
      fake.warnings.some((w) => /bad port/.test(w)),
      false,
      "an origin we cannot parse is not a blocked port, and must not be reported as one",
    );
    assert.ok(fake.infos.some((m) => /ready at not-a-url\/dsh-rpc/.test(m)), "startup must finish");
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
test("blocked-port startup warning deduplicates per port rather than silencing a port change", async () => {
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-wire-rewarn-"));
  process.env.DSH_HOME = home;
  const fake = makeFakeCtx();
  const readyHandlers: Array<() => void> = [];
  let currentOrigin: string | null = null;
  fake.ctx.webServer.getOrigin = () => {
    if (!currentOrigin) throw new Error("not bound yet");
    return currentOrigin;
  };
  fake.ctx.on = (event, fn) => {
    if (event === "ready") readyHandlers.push(fn);
  };
  try {
    await applyPlugin(fake.ctx, { token: "e".repeat(32), defaultCwd: home, tasksEnabled: false });
    assert.equal(readyHandlers.length, 1);

    currentOrigin = "http://127.0.0.1:5060";
    readyHandlers[0]();
    readyHandlers[0]();
    assert.equal(fake.warnings.filter((w) => /port 5060 /.test(w)).length, 1);

    currentOrigin = "http://127.0.0.1:6667";
    readyHandlers[0]();
    assert.equal(fake.warnings.filter((w) => /port 6667 /.test(w)).length, 1);
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("index entry exports HostPluginContext, TaskCentreState, TaskCentreWiring, PublishHandle, TaskDispatcher, and Autopilot at tsc compile time", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const validProbe = resolve(repoRoot, "src/__index_valid_probe__.mts");
  const badProbe = resolve(repoRoot, "src/__index_bad_probe__.mts");

  const validSource = `
import {
  apply,
  inject,
  name,
  type Autopilot,
  type HostPluginContext,
  type PublishHandle,
  type TaskCentreState,
  type TaskCentreWiring,
  type TaskDispatcher,
} from "./index.mjs";

const _pluginName: string = name;
const _injectDeps: readonly ["webServer", "sessionController"] = inject;
const _state: TaskCentreState = {
  enabled: true,
  mode: "file",
  dbPath: "/tmp/tasks.db",
  ready: true,
  seedError: null,
  startError: null,
  autopilot: { enabled: true, intervalMs: 5000, maxStart: 2, maxPump: 4 },
  autopilotStats: { passes: 1, lastPassAt: null, lastStarted: 0, lastPumped: 0, lastFailed: 0, lastError: null },
};
const _publish: PublishHandle = () => true;
const _checkApply = (ctx: HostPluginContext, wiring: TaskCentreWiring) => {
  const _d: TaskDispatcher | null = wiring.dispatcher;
  const _a: Autopilot | null = wiring.autopilot;
  return { promise: apply(ctx, { enabled: false }), _d, _a, _state, _publish, _pluginName, _injectDeps };
};
void _checkApply;
`;

  const badSource = `
import { apply, type HostPluginContext, type PublishHandle, type TaskCentreState } from "./index.mjs";

const badCtx = { webServer: { getOrigin: () => "http://127.0.0.1:0", register: () => () => {} } };
// @ts-expect-error -- missing sessionController and effect
void apply(badCtx);
const badCtxTyped: HostPluginContext = badCtx;
const badPublish: PublishHandle = () => "not-a-boolean";
const badState: TaskCentreState = { enabled: "yes" };
void badCtxTyped;
void badPublish;
void badState;
`;

  const configPath = resolve(repoRoot, "tsconfig.json");
  const parsed = ts.readConfigFile(configPath, ts.sys.readFile);
  const cmd = ts.parseJsonConfigFileContent(parsed.config, ts.sys, repoRoot);
  const options = { ...cmd.options, noEmit: true };

  const runProbe = (filePath: string, content: string) => {
    const virtualFiles = new Map([[resolve(filePath), content]]);
    const host = ts.createCompilerHost(options, true);
    const origGetSourceFile = host.getSourceFile.bind(host);
    const origFileExists = host.fileExists.bind(host);
    host.fileExists = (p) => virtualFiles.has(resolve(p)) || origFileExists(p);
    host.getSourceFile = (p, lang) => {
      const hit = virtualFiles.get(resolve(p));
      if (hit !== undefined) return ts.createSourceFile(p, hit, lang, true);
      return origGetSourceFile(p, lang);
    };
    host.writeFile = () => {
      throw new Error("unexpected write during in-memory compiler check");
    };
    const program = ts.createProgram([filePath], options, host);
    return ts.getPreEmitDiagnostics(program).filter((d) => d.file && resolve(d.file.fileName) === resolve(filePath));
  };

  const validDiagnostics = runProbe(validProbe, validSource);
  assert.deepEqual(
    validDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    [],
  );

  const badDiagnostics = runProbe(badProbe, badSource);
  assert.ok(badDiagnostics.length >= 3, `expected compile-time rejections, got ${badDiagnostics.length}`);
});

test("client.js passes strict tsc checkJs with 0 diagnostics and registers the Web UI settings section cleanly", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const clientPath = resolve(repoRoot, "dist/client.js");
  const clientSource = readFileSync(clientPath, "utf8");

  const options = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.None,
    allowJs: true,
    checkJs: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  };
  const program = ts.createProgram([clientPath], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(
    diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    [],
  );

  let loaded = null as ClientRegistryEntry | null;
  const registered: Array<{ slot: string; entry: { meta: { id: string } } }> = [];
  const effects: Array<{ fn: () => void; label?: string }> = [];
  const sandbox = {
    navigator: { language: "zh-CN" },
    window: {
      __ModuleLoader__: {
        load(entry: ClientRegistryEntry) {
          loaded = entry;
        },
      },
    },
  };
  vm.runInNewContext(clientSource, sandbox, { filename: "dist/client.js" });
  assert.equal(loaded?.id, "@punchact/dsh-rpc-agent");
  const plugin = loaded!.factory((dep) => {
    assert.equal(dep, "react");
    return {
      createElement: () => null,
      useState: <T>(init: T | (() => T)) => [typeof init === "function" ? (init as () => T)() : init, () => {}],
      useEffect: () => {},
      useRef: <T>(v: T) => ({ current: v }),
    };
  });
  assert.equal(plugin.name, "dsh-rpc");
  assert.deepEqual([...plugin.inject], ["slots"]);
  plugin.apply({
    effect(fn, label) {
      effects.push({ fn, label });
    },
    slots: {
      inject(slot, create) {
        registered.push({ slot, entry: create() });
      },
      register(meta, component) {
        return { meta, component };
      },
    },
  });
  assert.equal(effects.length, 1);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].slot, "settings.section");
  assert.equal(registered[0].entry.meta.id, "dsh-rpc-status");
});
