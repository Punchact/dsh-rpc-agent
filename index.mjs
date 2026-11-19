// @punchact/dsh-rpc-agent — loopback JSON-RPC bridge for DeepSeek Harness.
//
// Design constraints that shaped this file:
//  * Zero dependencies. A bundle installed into a profile must not need a peer
//    package to resolve, so there is no schemastery `Config` export and no
//    import from `@deepseek-ai/*`; config is validated by hand.
//  * No second listener. The Host already runs `webServer` for the Web UI, so
//    the bridge mounts routes on it and inherits its origin, port and loopback
//    posture.
//  * Fail loud on a bad config, stay inert (but loaded) when disabled.

import { join } from "node:path";

import { createAntigravityAdapter } from "./lib/adapters/antigravity.mjs";
import { createCodexAdapter } from "./lib/adapters/codex.mjs";
import { createDshAdapter } from "./lib/adapters/dsh.mjs";
import { dshHome, endpointPath, loadOrCreateToken, tokenPath, writeEndpoint } from "./lib/auth.mjs";
import { createApprovalState } from "./lib/approval-state.mjs";
import { createApprovalGate } from "./lib/approvals.mjs";
import { probesFromAdapter } from "./lib/agents/probe.mjs";
import { MAX_WAIT_SLICE_MS, MIN_WAIT_SLICE_MS, resolveConfig } from "./lib/config.mjs";
import { buildDispatcher, registerRoutes } from "./lib/http.mjs";
import { createDshAdapterOps, createMethods } from "./lib/methods.mjs";
import { isOwnedSession, useOwnedState } from "./lib/owned.mjs";
import { createPendingStore } from "./lib/pending.mjs";
import { createStats } from "./lib/stats.mjs";
import { createDispatcher } from "./lib/tasks/dispatch.mjs";
import { createAutopilot } from "./lib/tasks/autopilot.mjs";
import { createTaskEngine, seedBaselineEntities } from "./lib/tasks/engine.mjs";
import { openStore } from "./lib/tasks/store.mjs";
import { PLUGIN_NAME, PLUGIN_VERSION } from "./lib/version.mjs";

export const name = "dsh-rpc";
export const inject = ["webServer", "sessionController"];

export async function apply(ctx, input = {}) {
  const log = scopedLogger(ctx);
  const config = resolveConfig(input);

  // A clamped slice is still safe, but silently ignoring a configured number is
  // how a deployment ends up believing it waits four minutes when it waits two.
  if (config.maxWaitSliceMsRequested !== undefined) {
    log.warn?.(
      `[dsh-rpc] maxWaitSliceMs ${config.maxWaitSliceMsRequested} is outside ` +
        `${MIN_WAIT_SLICE_MS}..${MAX_WAIT_SLICE_MS}; using ${config.maxWaitSliceMs} ` +
        "(one HTTP response cannot stay quiet for 300 s)",
    );
  }

  if (!config.enabled) {
    log.info?.("[dsh-rpc] loaded but disabled by config");
    return;
  }

  const token = loadOrCreateToken(config);
  const state = {
    token: token.token,
    tokenSource: token.source,
    tokenPath: tokenPath(config),
    endpointPath: endpointPath(),
    endpointUrl: null,
    startedAt: Date.now(),
  };

  // Escalations this bridge holds for a caller to answer (approvals.mode=delegate).
  // The store owns the deadline: the Host's approval service has none, and an
  // unanswered question has to become a refusal rather than a hang.
  const approvals = createPendingStore({ deadlineMs: config.approvals.deadlineMs, log });

  // What the gate has to remember across restarts: how many escalations each
  // session already won, which sessions this bridge created, and any preset it
  // widened without getting a chance to put it back. Written only when approvals
  // are on — with them off nothing here answers for anybody, so the file would be
  // noise on every session create.
  const approvalState = config.approvals.mode === "off" ? null : createApprovalState({ log });
  if (approvalState) {
    useOwnedState(approvalState);
    approvalState.prune();
  }

  let taskStore = null;
  let taskEngine = null;
  let taskDispatcher = null;
  let adapters = null;

  // What the task centre actually did at startup. ping() reports this verbatim:
  // a breaker that is on but whose store never opened has to be visible, not
  // inferred from an empty list.
  const taskCentre = {
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

  if (config.tasksEnabled) {
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
          workspace: { workspaceId: "local", rootPath: config.defaultCwd || process.cwd() },
        });
      } catch (err) {
        taskCentre.seedError = err?.message ?? String(err);
        ctx.logger?.warn?.(`[dsh-rpc] task bootstrap seeding failed: ${taskCentre.seedError}`);
      }

      // ctx.get() is strict in the Host: asking for a service nobody provides
      // throws, which used to abort the whole task-centre startup and leave the
      // plugin on a silent in-memory store. Treat a missing service as "no
      // injection" instead of a fatal error.
      let factories = null;
      try {
        factories = ctx?.taskAdapterFactories ?? ctx?.get?.("taskAdapterFactories") ?? null;
      } catch {
        factories = null;
      }
      if (!factories || typeof factories !== "object") {
        factories = {
          antigravity: createAntigravityAdapter,
          codex: createCodexAdapter,
        };
      }
      adapters = {};
      const extKind = config.tasksExternalAdapter;
      const extCfg = extKind !== "none" ? config.tasksAdapters?.[extKind] : null;
      if (extKind !== "none" && extCfg && extCfg.enabled !== false) {
        try {
          const makeAdapter = factories?.[extKind];
          if (typeof makeAdapter !== "function") {
            throw new Error(`no adapter factory for "${extKind}"`);
          }
          adapters[extKind] = makeAdapter(extCfg);
        } catch (err) {
          log.warn?.(`[dsh-rpc] failed to initialize ${extKind} adapter: ${err?.message ?? String(err)}`);
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

      taskEngine = createTaskEngine(taskStore);
      taskDispatcher = createDispatcher({
        store: taskStore,
        engine: taskEngine,
        adapters,
        maxConcurrent: config.tasksMaxConcurrent,
        logger: log,
        // Raw adapter text stays out of the log unless an operator opts in; the
        // ledger and the tool replies always carry the curated reason instead.
        debugRawAdapterErrors: config.tasksAdapterDebugDetail === true,
      });

      taskCentre.ready = true;

      // The caller-facing tool surface has no dispatch/pump on purpose, so the machine
      // side has to drive the ledger: without this pass a task submitted through MCP
      // would stay queued until a human ran `tasks dispatch` by hand.
      const autopilot =
        config.tasksAutopilot === false
          ? null
          : createAutopilot({
              engine: taskEngine,
              dispatcher: taskDispatcher,
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

      const autopilotStats = {
        passes: 0,
        lastPassAt: null,
        lastStarted: 0,
        lastPumped: 0,
        lastFailed: 0,
        lastError: null,
      };
      taskCentre.autopilotStats = autopilotStats;

      const drainTimer = setInterval(() => {
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
              .catch((err) => {
                autopilotStats.lastError = err?.message ?? String(err);
              })
          : Promise.resolve();
        // Effects (adapter stop/kill requests) always drain, even with autopilot off:
        // they are leftovers of decisions already made, not new work.
        tick.finally(() => taskDispatcher.drainEffects({ limit: 50 }).catch(() => {}));
      }, config.tasksAutopilotIntervalMs);
      drainTimer.unref?.();

      const cleanupTasks = () => {
        try {
          clearInterval(drainTimer);
        } catch {
          // ignore timer cleanup errors
        }
        try {
          taskStore?.close?.();
        } catch {
          // ignore store close errors
        }
      };

      if (typeof ctx.effect === "function") {
        ctx.effect(() => cleanupTasks, "dsh-rpc.task-hub");
      } else if (typeof ctx.on === "function") {
        ctx.on("dispose", cleanupTasks);
      }
    } catch (err) {
      taskCentre.mode = "failed";
      taskCentre.ready = false;
      taskCentre.startError = err?.message ?? String(err);
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
    }
  }

  const methods = createMethods(
    {
      sessionController: ctx.sessionController,
      webServer: ctx.webServer,
      approvals,
      taskStore,
      taskEngine,
      taskDispatcher,
      adapters,
      taskCentre,
      // A capability card describes one executor, so only that executor can verify it:
      // resolve the adapter the agent is assigned to and hand its read-only control
      // table to the probe runner. Without this the runner sees no probe for any
      // control and reports every card as `unknown`, forever.
      agentProbes: (row) => probesFromAdapter(adapters?.[row?.adapter_kind]),
    },
    config,
    ctx,
    state,
  );
  const dispatch = buildDispatcher(methods);
  // Call accounting feeds the Settings page. `stats` lives next to the routes
  // because that is the only layer that sees every admitted call, including the
  // ones that fail before reaching a method.
  const stats = createStats({ startedAt: Date.now(), pid: process.pid });
  const routes = registerRoutes({
    webServer: ctx.webServer,
    config,
    dispatch,
    methods,
    state,
    ctx,
    log,
    stats,
  });

  // Refuse in-place escalations from our own sessions (lib/approvals.mjs). Off by
  // default: the Host already fails closed with nobody answering, and taking a
  // decision away from a human watching the GUI is not a safe default.
  //
  // The seam is `tools/pre-execute`, not `approval/request`: the approval service
  // dispatches through `scopeTarget(req.agent, req.agent)`, which only reaches
  // answerers inside the agent's own composition. Measured on a live session — a
  // listener on this context (and on the root context) was never called while the
  // GUI kept the dialog open. The pre-execute waterfall is global, so it can.
  const gate = createApprovalGate({
    mode: config.approvals.mode,
    isOwned: isOwnedSession,
    onDeny: () => stats.recordApproval("denied"),
    onAllow: () => stats.recordApproval("allowed"),
    applyPreset: async (sessionId, name) => {
      const service = ctx.get?.("permissionPresets");
      if (!service?.set) throw new Error("this deployment exposes no permissionPresets service");
      const session = ctx.get?.("sessions")?.get?.(sessionId);
      if (!session) throw new Error(`session ${sessionId} is not live`);
      service.set(session, name);
      return name;
    },
    currentPreset: (sessionId) => {
      const service = ctx.get?.("permissionPresets");
      const session = ctx.get?.("sessions")?.get?.(sessionId);
      if (!service?.current || !session) return null;
      return service.current(session) ?? null;
    },
    store: approvals,
    state: approvalState,
    log,
  });
  if (gate) {
    // A killed process cannot run `dispose`, so a preset this bridge widened and
    // never restored is still wide right now. The journal is the only record of
    // that debt, and settling it is the first thing to do.
    gate
      .recover?.()
      ?.then?.((result) => {
        if (result?.restored || result?.failed) {
          log.info?.(`[dsh-rpc] approval journal: restored ${result.restored}, failed ${result.failed}`);
        }
      })
      ?.catch?.((error) => log.warn?.(`[dsh-rpc] approval recovery failed: ${error?.message ?? error}`));
    if (typeof ctx.on === "function") {
      ctx.on("tools/pre-execute", gate.pre, { prepend: true });
      // `allow-once` widens the preset only for the approved call, so the gate
      // has to see that call finish. Its own safety timer restores the preset
      // even when the tool never reports.
      ctx.on("tools/post-execute", gate.post);
      log.info?.(
        `[dsh-rpc] approvals.mode=${config.approvals.mode}: ` +
          (config.approvals.mode === "delegate"
            ? `holding sandbox escalations from sessions this bridge created for up to ${config.approvals.deadlineMs} ms`
            : "refusing sandbox escalations from sessions this bridge created"),
      );
    } else {
      log.warn?.(
        `[dsh-rpc] approvals.mode=${config.approvals.mode} needs ctx.on: the escalation gate is not registered`,
      );
    }
    // A reload or a shutdown must not leave a session widened with nothing left to
    // put it back: `dispose` restores every widened preset and stops the fallback
    // timers.
    if (typeof ctx.effect === "function") {
      ctx.effect(() => () => gate.dispose?.(), "dsh-rpc.approval-gate");
    }
  }

  // Publish the endpoint so out-of-process callers (CLI, MCP bridge, curl) can
  // discover url + token without being told the port. `getOrigin()` throws
  // before the listener binds, hence the `ready` retry.
  const publish = () => {
    try {
      const origin = ctx.webServer.getOrigin();
      if (!origin) return false;
      state.endpointUrl = `${origin}${config.path}`;
      writeEndpoint({
        url: state.endpointUrl,
        origin,
        path: config.path,
        version: PLUGIN_VERSION,
      });
      return true;
    } catch {
      return false;
    }
  };

  if (!publish() && typeof ctx.on === "function") {
    ctx.on("ready", () => publish());
  }

  ctx.effect(() => () => routes.dispose(), "dsh-rpc.routes");

  log.info?.(
    `[dsh-rpc-agent] ${PLUGIN_NAME} ${PLUGIN_VERSION} ready at ${state.endpointUrl ?? config.path} ` +
      `(token: ${state.tokenSource}, loopback_only=${!config.allowRemote})`,
  );
}

function scopedLogger(ctx) {
  const candidate = ctx?.logger;
  if (candidate && typeof candidate.info === "function") return candidate;
  if (typeof candidate === "function") {
    try {
      const scoped = candidate("dsh-rpc");
      if (scoped && typeof scoped.info === "function") return scoped;
    } catch {
      // fall through
    }
  }
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}
