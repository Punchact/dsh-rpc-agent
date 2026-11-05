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
import { resolveConfig } from "./lib/config.mjs";
import { buildDispatcher, registerRoutes } from "./lib/http.mjs";
import { createMethods } from "./lib/methods.mjs";
import { createStats } from "./lib/stats.mjs";
import { PLUGIN_NAME, PLUGIN_VERSION } from "./lib/version.mjs";

export const name = "dsh-rpc";
export const inject = ["webServer", "sessionController"];

export function apply(ctx, input = {}) {
  const log = scopedLogger(ctx);
  const config = resolveConfig(input);

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

  const methods = createMethods(
    { sessionController: ctx.sessionController, webServer: ctx.webServer },
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
