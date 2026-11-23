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

import { endpointPath, loadOrCreateToken, tokenPath, writeEndpoint } from "./lib/auth.mjs";
import { createApprovalState } from "./lib/approval-state.mjs";
import { createApprovalGate } from "./lib/approvals.mjs";
import { MAX_WAIT_SLICE_MS, MIN_WAIT_SLICE_MS, resolveConfig } from "./lib/config.mjs";
import { buildDispatcher, registerRoutes, type WebServerLike } from "./lib/http.mjs";
import { createMethods, type SessionControllerLike } from "./lib/methods.mjs";
import { isOwnedSession, useOwnedState } from "./lib/owned.mjs";
import { createPendingStore } from "./lib/pending.mjs";
import { createStats } from "./lib/stats.mjs";
import { isFetchBlockedPort } from "./lib/transport.mjs";
import {
  wireTaskCentre,
  type AdapterFactory,
  type AdapterFactoryMap,
  type Autopilot,
  type AutopilotConfigProjection,
  type AutopilotStatsProjection,
  type PluginLogger,
  type TaskCentreState,
  type TaskCentreWiring,
  type TaskDispatcher,
} from "./lib/tasks/wire.mjs";
import { PLUGIN_NAME, PLUGIN_VERSION } from "./lib/version.mjs";

export type {
  AdapterFactory,
  AdapterFactoryMap,
  Autopilot,
  AutopilotConfigProjection,
  AutopilotStatsProjection,
  PluginLogger,
  TaskCentreState,
  TaskCentreWiring,
  TaskDispatcher,
};

export interface BridgeState {
  token: string;
  tokenSource: "config" | "env" | "file" | "generated" | string;
  tokenPath: string;
  endpointPath: string;
  endpointUrl: string | null;
  startedAt: number;
}

export interface PublishHandle {
  (): boolean;
}

export interface HostWebServer extends WebServerLike {
  getOrigin(): string;
}

export interface HostPluginContext {
  webServer: HostWebServer;
  sessionController: SessionControllerLike;
  logger?: PluginLogger | ((scope: string) => PluginLogger);
  get?: (name: string) => unknown;
  on?: (
    event: string,
    listener: (...args: any[]) => unknown,
    options?: { prepend?: boolean },
  ) => unknown;
  effect: (fn: () => (() => unknown) | void, label?: string) => unknown;
  taskAdapterFactories?: AdapterFactoryMap | null;
  [key: string]: unknown;
}

interface PermissionPresetsServiceLike {
  set?: (session: unknown, name: string) => unknown;
  current?: (session: unknown) => string | null | undefined;
}

interface SessionsServiceLike {
  get?: (sessionId: string) => unknown;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && error.message !== undefined && error.message !== null) {
    return String(error.message);
  }
  return String(error);
}

export const name = "dsh-rpc";
export const inject: readonly ["webServer", "sessionController"] = ["webServer", "sessionController"];

export async function apply(ctx: HostPluginContext, input: Record<string, unknown> = {}): Promise<void> {
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
  const state: BridgeState = {
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

  const taskWiring = await wireTaskCentre({ ctx, config, approvals, log });

  const methods = createMethods(
    {
      sessionController: ctx.sessionController,
      webServer: ctx.webServer,
      approvals,
      taskStore: taskWiring.store,
      taskEngine: taskWiring.engine,
      taskDispatcher: taskWiring.dispatcher,
      adapters: taskWiring.adapters,
      taskCentre: taskWiring.status,
      agentProbes: taskWiring.agentProbes,
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
    applyPreset: async (sessionId, presetName) => {
      const service = ctx.get?.("permissionPresets") as PermissionPresetsServiceLike | undefined;
      if (!service?.set) throw new Error("this deployment exposes no permissionPresets service");
      const sessions = ctx.get?.("sessions") as SessionsServiceLike | undefined;
      const session = sessions?.get?.(sessionId);
      if (!session) throw new Error(`session ${sessionId} is not live`);
      service.set(session, presetName);
      return presetName;
    },
    currentPreset: (sessionId) => {
      const service = ctx.get?.("permissionPresets") as PermissionPresetsServiceLike | undefined;
      const sessions = ctx.get?.("sessions") as SessionsServiceLike | undefined;
      const session = sessions?.get?.(sessionId);
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
      ?.catch?.((error: unknown) => log.warn?.(`[dsh-rpc] approval recovery failed: ${errorMessage(error)}`));
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
  let warnedBlockedPort: number | null = null;
  const publish: PublishHandle = () => {
    try {
      const origin = ctx.webServer.getOrigin();
      if (!origin) return false;
      // The bridge does not choose the port; the Host does. A port fetch refuses
      // ("bad port") would leave every out-of-process caller unable to connect
      // while this process looks perfectly healthy, so say it out loud once per
      // blocked port. Keep it in its own guard: a warning must never be able to
      // stop the endpoint from being published.
      try {
        const parsed = new URL(origin);
        const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
        if (warnedBlockedPort !== port && isFetchBlockedPort(port)) {
          warnedBlockedPort = port;
          log.warn?.(
            `[dsh-rpc-agent] the Host's web port ${port} is one fetch refuses to connect to ("bad port"). ` +
              "Out-of-process callers (CLI, MCP bridge) will fail with EBADPORT until the Harness starts on another port.",
          );
        }
      } catch {
        // An origin we cannot parse is the caller's problem, not a reason to skip
        // publishing the url it already gave us.
      }
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

function scopedLogger(ctx: HostPluginContext | null | undefined): PluginLogger {
  const candidate = ctx?.logger;
  if (candidate && typeof candidate === "object" && typeof candidate.info === "function") return candidate;
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
