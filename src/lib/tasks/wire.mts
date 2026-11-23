// Task-centre assembly extracted from `src/index.mts`: store, engine, dispatcher,
// adapter factory resolution, 5-second autopilot loop, shutdown cleanup, and `ping.taskCentre`
// diagnostics. Kept separate from the Host bridge so `index.mts` only mounts the plugin.

import { join } from "node:path";

import { createAntigravityAdapter } from "../adapters/antigravity.mjs";
import type { RuntimeAdapter } from "../adapters/base.mjs";
import { createCodexAdapter } from "../adapters/codex.mjs";
import { createDshAdapter } from "../adapters/dsh.mjs";
import { probesFromAdapter, type ProbeMap } from "../agents/probe.mjs";
import { dshHome } from "../auth.mjs";
import type { ResolvedConfig } from "../config.mjs";
import {
  createDshAdapterOps,
  type ApprovalsServiceLike,
  type SessionControllerLike,
} from "../methods.mjs";
import { createAutopilot, type AutopilotStepResult } from "./autopilot.mjs";
import {
  createDispatcher,
  type DrainEffectsParams,
  type DrainEffectsResult,
  type PumpParams,
  type PumpResult,
  type StartTaskParams,
  type StartTaskResult,
} from "./dispatch.mjs";
import { createTaskEngine, seedBaselineEntities, type TaskEngine } from "./engine.mjs";
import { openStore, type AgentRow, type TaskStore } from "./store.mjs";

export interface PluginLogger {
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
  debug?: (message: string, ...args: unknown[]) => void;
}

export type AdapterFactory = (config: Record<string, unknown>) => RuntimeAdapter;
export type AdapterFactoryMap = Record<string, AdapterFactory | undefined>;

export interface TaskDispatcher {
  startTask(params?: StartTaskParams): Promise<StartTaskResult>;
  pump(params?: PumpParams): Promise<PumpResult>;
  drainEffects(params?: DrainEffectsParams): Promise<DrainEffectsResult>;
}

export interface Autopilot {
  step(): Promise<AutopilotStepResult>;
  limits: { maxStart: number; maxPump: number };
}

export interface AutopilotConfigProjection {
  enabled: boolean;
  intervalMs: number | null;
  maxStart: number | null;
  maxPump: number | null;
}

export interface AutopilotStatsProjection {
  passes: number;
  lastPassAt: string | null;
  lastStarted: number;
  lastPumped: number;
  lastFailed: number;
  lastError: string | null;
}

export interface TaskCentreState {
  enabled: boolean;
  mode: "off" | "file" | "failed" | string;
  dbPath: string | null;
  ready: boolean;
  seedError: string | null;
  startError: string | null;
  autopilot: AutopilotConfigProjection | null;
  // A pass that runs and does nothing looks exactly like a pass that never ran, unless
  // the last pass says so; ping() reports this object verbatim.
  autopilotStats: AutopilotStatsProjection | null;
}

export interface TaskCentreWiring {
  store: TaskStore | null;
  engine: TaskEngine | null;
  dispatcher: TaskDispatcher | null;
  adapters: Record<string, RuntimeAdapter> | null;
  autopilot: Autopilot | null;
  status: TaskCentreState;
  agentProbes: (row: AgentRow) => ProbeMap;
  cleanup: () => Promise<void>;
}

export interface TaskCentreHostContext {
  sessionController: SessionControllerLike;
  logger?: PluginLogger | ((scope: string) => PluginLogger) | undefined;
  get?: ((name: string) => unknown) | undefined;
  on?: ((event: string, listener: (...args: unknown[]) => unknown, options?: { prepend?: boolean }) => unknown) | undefined;
  effect?: ((fn: () => (() => unknown) | void, label?: string) => unknown) | undefined;
  taskAdapterFactories?: AdapterFactoryMap | null | undefined;
  [key: string]: unknown;
}

export interface WireTaskCentreOptions {
  ctx: TaskCentreHostContext;
  config: ResolvedConfig;
  approvals: ApprovalsServiceLike | null;
  log: PluginLogger;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && error.message !== undefined && error.message !== null) {
    return String(error.message);
  }
  return String(error);
}

/**
 * Resolve external and built-in task adapters; an unavailable external adapter logs
 * a warning and degrades cleanly so baseline DSH tasks still start.
 */
function buildAdapters({
  ctx,
  config,
  approvals,
  log,
}: WireTaskCentreOptions): Record<string, RuntimeAdapter> {
  // ctx.get() is strict in the Host: asking for a service nobody provides
  // throws, which used to abort the whole task-centre startup and leave the
  // plugin on a silent in-memory store. Treat a missing service as "no
  // injection" instead of a fatal error.
  let factories: AdapterFactoryMap | null = null;
  try {
    factories = (ctx?.taskAdapterFactories ?? ctx?.get?.("taskAdapterFactories") ?? null) as AdapterFactoryMap | null;
  } catch {
    factories = null;
  }
  if (!factories || typeof factories !== "object") {
    factories = {
      antigravity: createAntigravityAdapter as AdapterFactory,
      codex: createCodexAdapter as AdapterFactory,
    };
  }

  let adapters: Record<string, RuntimeAdapter> = {};
  const extKind = config.tasksExternalAdapter;
  const extCfg = extKind !== "none" ? config.tasksAdapters?.[extKind] : null;
  if (extKind !== "none" && extCfg && extCfg.enabled !== false) {
    try {
      const makeAdapter = factories?.[extKind];
      if (typeof makeAdapter !== "function") {
        throw new Error(`no adapter factory for "${extKind}"`);
      }
      adapters[extKind] = makeAdapter(extCfg);
    } catch (err: unknown) {
      log.warn?.(`[dsh-rpc] failed to initialize ${extKind} adapter: ${errorMessage(err)}`);
      adapters = {};
    }
  }

  if (!adapters.dsh) {
    adapters.dsh = createDshAdapter({
      ops: createDshAdapterOps({
        sessionController: ctx.sessionController,
        config,
        ctx,
        approvals,
      }),
    });
  }

  return adapters;
}

/**
 * Start the bounded 5-second task-centre advance loop and return its shutdown cleanup.
 * Mutates `taskCentre.autopilot` and `taskCentre.autopilotStats` in place so `ping()`
 * reads live pass counters without copying.
 */
function startAutopilotLoop({
  taskStore,
  taskEngine,
  dispatcher,
  config,
  taskCentre,
  log,
}: {
  taskStore: TaskStore;
  taskEngine: TaskEngine;
  dispatcher: TaskDispatcher;
  config: ResolvedConfig;
  taskCentre: TaskCentreState;
  log: PluginLogger;
}): { autopilot: Autopilot | null; cleanup: () => Promise<void> } {
  // The caller-facing tool surface has no dispatch/pump on purpose, so the machine
  // side has to drive the ledger: without this pass a task submitted through MCP
  // would stay queued until a human ran `tasks dispatch` by hand.
  const autopilot: Autopilot | null =
    config.tasksAutopilot === false
      ? null
      : createAutopilot({
          engine: taskEngine,
          dispatcher,
          logger: log,
          maxStart: config.tasksAutopilotMaxStart,
          maxPump: config.tasksAutopilotMaxPump,
          pumpMaxSteps: config.tasksDispatchMaxSteps,
        });
  taskCentre.autopilot = autopilot
    ? {
        enabled: true,
        intervalMs: config.tasksAutopilotIntervalMs,
        maxStart: config.tasksAutopilotMaxStart,
        maxPump: config.tasksAutopilotMaxPump,
      }
    : { enabled: false, intervalMs: null, maxStart: null, maxPump: null };

  const autopilotStats: AutopilotStatsProjection = {
    passes: 0,
    lastPassAt: null,
    lastStarted: 0,
    lastPumped: 0,
    lastFailed: 0,
    lastError: null,
  };
  taskCentre.autopilotStats = autopilotStats;

  let shuttingDown = false;
  let passRunning = false;
  let inFlightPass: Promise<unknown> = Promise.resolve();
  const drainTimer = setInterval(() => {
    // A pass owns `passRunning` until its `drainEffects` settles. Starting another pass while
    // one is still draining would let the newer (usually faster) chain clear `passRunning`
    // first and mark the hub idle while the older chain is still writing — and an idle-looking
    // shutdown then closes the store underneath it.
    if (shuttingDown || passRunning) return;
    passRunning = true;
    const tick = autopilot
      ? autopilot
          .step()
          .then((result) => {
            autopilotStats.passes += 1;
            autopilotStats.lastPassAt = new Date().toISOString();
            autopilotStats.lastStarted = result?.started?.length ?? 0;
            autopilotStats.lastPumped = result?.pumped?.length ?? 0;
            autopilotStats.lastFailed = result?.failed?.length ?? 0;
            autopilotStats.lastError = result?.failed?.length ? (result.failed[0]?.message ?? null) : null;
          })
          .catch((err: unknown) => {
            autopilotStats.lastError = errorMessage(err);
          })
      : Promise.resolve();
    // Effects (adapter stop/kill requests) always drain, even with autopilot off:
    // they are leftovers of decisions already made, not new work.
    inFlightPass = tick
      .finally(() => dispatcher.drainEffects({ limit: 50 }).catch(() => {}))
      .finally(() => {
        passRunning = false;
      });
  }, config.tasksAutopilotIntervalMs);
  drainTimer.unref?.();

  const cleanup = async (): Promise<void> => {
    shuttingDown = true;
    try {
      clearInterval(drainTimer);
    } catch {
      // ignore timer cleanup errors
    }
    // Let the pass that is already running finish before the ledger goes away. Closing the
    // store under an in-flight transition surfaces as a write error in the middle of
    // shutdown, and a start that is interrupted mid-transition is exactly what leaves a
    // `dispatching` task with no attempt row. When nothing is running we close right here,
    // synchronously: a shutdown that is idle has nothing to wait for, and deferring the
    // close past the caller's next statement would leave the file open behind a `dispose()`.
    if (passRunning) {
      try {
        await inFlightPass;
      } catch {
        // ignore in-flight pass errors during shutdown
      }
    }
    try {
      taskStore.close?.();
    } catch {
      // ignore store close errors
    }
  };

  return { autopilot, cleanup };
}

/**
 * Assemble the task-centre runtime (SQLite store, engine, adapters, dispatcher,
 * autopilot loop, and disposal hook) when `config.tasksEnabled` is true.
 */
export async function wireTaskCentre(options: WireTaskCentreOptions): Promise<TaskCentreWiring> {
  const { ctx, config, log } = options;

  let taskStore: TaskStore | null = null;
  let taskEngine: TaskEngine | null = null;
  let taskDispatcher: TaskDispatcher | null = null;
  let adapters: Record<string, RuntimeAdapter> | null = null;
  let autopilot: Autopilot | null = null;
  let cleanup: () => Promise<void> = async () => {};

  // What the task centre actually did at startup. ping() reports this verbatim:
  // a breaker that is on but whose store never opened has to be visible, not
  // inferred from an empty list.
  const taskCentre: TaskCentreState = {
    enabled: config.tasksEnabled === true,
    mode: "off",
    dbPath: null,
    ready: false,
    seedError: null,
    startError: null,
    autopilot: null,
    // A pass that runs and does nothing looks exactly like a pass that never ran, unless
    // the last pass says so; ping() reports this object verbatim.
    autopilotStats: null,
  };

  // A capability card describes one executor, so only that executor can verify it:
  // resolve the adapter the agent is assigned to and hand its read-only control
  // table to the probe runner. Without this the runner sees no probe for any
  // control and reports every card as `unknown`, forever.
  const agentProbes = (row: AgentRow): ProbeMap => probesFromAdapter(adapters?.[row?.adapter_kind]);

  if (!config.tasksEnabled) {
    return {
      store: null,
      engine: null,
      dispatcher: null,
      adapters: null,
      autopilot: null,
      status: taskCentre,
      agentProbes,
      cleanup,
    };
  }

  try {
    const dbPath = config.tasksDbPath || join(dshHome(), "storages", "task-center", "tasks.db");
    taskStore = openStore({ path: dbPath });
    taskCentre.mode = "file";
    taskCentre.dbPath = dbPath;

    // A DSH install has one human operator; seed baseline identity + local workspace
    // so preview/submit work immediately without a separate onboarding step. This is
    // awaited: a failed seed must be reported by ping(), not left as a background
    // rejection that turns every submit into "principal not found".
    try {
      await seedBaselineEntities(taskStore, {
        principal: { principalId: "local-operator", kind: "operator" },
        // `tasksWorkspaceRoot` says which tree this bridge owns: external executors start
        // their sessions in it, which is what puts them under the matching project in the
        // executor's own window. Without it the workspace stays wherever the Host runs.
        workspace: {
          workspaceId: "local",
          rootPath: config.tasksWorkspaceRoot || config.defaultCwd || process.cwd(),
          ...(config.tasksWorkspaceRoot ? { replaceRoot: true } : {}),
        },
      });
    } catch (err: unknown) {
      taskCentre.seedError = errorMessage(err);
      if (ctx.logger && typeof ctx.logger === "object") {
        ctx.logger.warn?.(`[dsh-rpc] task bootstrap seeding failed: ${taskCentre.seedError}`);
      }
    }

    adapters = buildAdapters(options);
    taskEngine = createTaskEngine(taskStore);
    const createdDispatcher = createDispatcher({
      store: taskStore,
      engine: taskEngine,
      adapters,
      maxConcurrent: config.tasksMaxConcurrent,
      logger: log,
      // Raw adapter text stays out of the log unless an operator opts in; the
      // ledger and the tool replies always carry the curated reason instead.
      debugRawAdapterErrors: config.tasksAdapterDebugDetail === true,
    });
    taskDispatcher = createdDispatcher;
    taskCentre.ready = true;

    const loop = startAutopilotLoop({
      taskStore,
      taskEngine,
      dispatcher: createdDispatcher,
      config,
      taskCentre,
      log,
    });
    autopilot = loop.autopilot;
    cleanup = loop.cleanup;

    if (typeof ctx.effect === "function") {
      ctx.effect(() => cleanup, "dsh-rpc.task-hub");
    } else if (typeof ctx.on === "function") {
      ctx.on("dispose", cleanup);
    }
  } catch (err: unknown) {
    taskCentre.mode = "failed";
    taskCentre.ready = false;
    taskCentre.startError = errorMessage(err);
    log.warn?.(`[dsh-rpc] task center disabled due to startup error: ${taskCentre.startError}`);
    try {
      taskStore?.close?.();
    } catch {
      // best effort
    }
    taskStore = null;
    taskEngine = null;
    taskDispatcher = null;
    adapters = null;
    autopilot = null;
    cleanup = async () => {};
  }

  return {
    store: taskStore,
    engine: taskEngine,
    dispatcher: taskDispatcher,
    adapters,
    autopilot,
    status: taskCentre,
    agentProbes,
    cleanup,
  };
}
