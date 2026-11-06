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
import { createApprovalGate } from "./lib/approvals.mjs";
import { MAX_WAIT_SLICE_MS, MIN_WAIT_SLICE_MS, resolveConfig } from "./lib/config.mjs";
import { buildDispatcher, registerRoutes } from "./lib/http.mjs";
import { createMethods } from "./lib/methods.mjs";
import { isOwnedSession } from "./lib/owned.mjs";
import { createPendingStore } from "./lib/pending.mjs";
import { createStats } from "./lib/stats.mjs";
import { PLUGIN_NAME, PLUGIN_VERSION } from "./lib/version.mjs";

export const name = "dsh-rpc";
export const inject = ["webServer", "sessionController"];

export function apply(ctx, input = {}) {
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
  };

  // Escalations this bridge holds for a caller to answer (approvals.mode=delegate).
  // The store owns the deadline: the Host's approval service has none, and an
  // unanswered question has to become a refusal rather than a hang.
  const approvals = createPendingStore({ deadlineMs: config.approvals.deadlineMs, log });

  const methods = createMethods(
    { sessionController: ctx.sessionController, webServer: ctx.webServer, approvals },
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
  const escalateOrPass = createApprovalGate({
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
    log,
  });
  if (escalateOrPass) {
    if (typeof ctx.on === "function") {
      ctx.on("tools/pre-execute", escalateOrPass, { prepend: true });
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
