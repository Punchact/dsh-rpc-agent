// Manual config resolution. The plugin deliberately exports no `Config` schema,
// so it carries zero runtime and peer dependencies: a bundle that has to be
// installed into a profile must not need `@deepseek-ai/schemastery` to resolve.
// Validation is therefore explicit, and every failure names the offending key.

const DEFAULTS = {
  enabled: true,
  token: "",
  tokenFile: "",
  path: "/dsh-rpc",
  allowRemote: false,
  defaultCwd: "",
  defaultAgentPreset: "",
  defaultTimeoutMs: 10 * 60 * 1000,
  // No single HTTP response may be quiet for longer than this: Node's built-in
  // fetch gives up after 300 s (headersTimeout), so a longer wait dies in the
  // transport before the bridge can answer. A measured slice costs 8-21 ms of
  // overhead on loopback, so a short slice is nearly free and buys margin: two
  // minutes leave three of the five available, and ten minutes of waiting
  // becomes five round-trips instead of two.
  maxWaitSliceMs: 2 * 60 * 1000,
  historyBudgetMs: 30 * 1000,
  maxBodyBytes: 1024 * 1024,
  maxSessions: 200,
  logRequests: false,
  // `off` keeps the Host's own fail-closed behaviour. `deny` makes this bridge
  // answer for the sessions it created, so an unattended turn is told "no"
  // instead of waiting for a human who is not there. See lib/approvals.mjs.
  approvals: Object.freeze({ mode: "off", deadlineMs: 60_000 }),
};

/** The approval modes this build understands. */
export const APPROVAL_MODES = ["off", "deny", "delegate"];

/**
 * Ceiling and floor for a slice, as transport facts rather than preferences:
 * the client's transport budget is `slice + 30 s`, which has to stay under the
 * 300 s `headersTimeout`, so 240 s is the most one response may spend waiting.
 * A configured value outside `[MIN, MAX]` is clamped with a warning instead of
 * rejected: a tuning mistake must not keep the bridge from booting.
 */
export const MAX_WAIT_SLICE_MS = 4 * 60 * 1000;
export const MIN_WAIT_SLICE_MS = 1_000;

/**
 * How long one `history` read may stay silent. A snapshot is a bounded read, so
 * anything slower than this means the Host stopped answering — not that the
 * session is big (500 records serialise in 170 ms on a 19 MB session).
 */
export const MAX_HISTORY_BUDGET_MS = 2 * 60 * 1000;
export const MIN_HISTORY_BUDGET_MS = 100;

/**
 * An escalation waits for a caller's answer. The floor keeps a mis-set value
 * from turning every request into an instant refusal; the ceiling keeps a
 * mis-set value from recreating the hang this feature exists to remove.
 */
export const MAX_APPROVAL_DEADLINE_MS = 10 * 60 * 1000;
export const MIN_APPROVAL_DEADLINE_MS = 1_000;

export class ConfigError extends Error {
  constructor(problems) {
    super(`invalid dsh-rpc config: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function resolveConfig(input = {}) {
  if (input === null || input === undefined) input = {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigError(["config must be an object"]);
  }

  const problems = [];
  const take = (key, check, message) => {
    const raw = input[key];
    if (raw === undefined) return DEFAULTS[key];
    const value = check(raw);
    if (value === undefined) problems.push(`${key}: ${message}`);
    return value;
  };

  const asBoolean = (raw) => (typeof raw === "boolean" ? raw : undefined);
  const asString = (raw) => (typeof raw === "string" ? raw.trim() : undefined);
  const asPositiveInt = (raw) =>
    Number.isInteger(raw) && raw > 0 ? raw : undefined;

  // `{ mode, deadlineMs }` is the only shape today, so a partial object is
  // accepted and a wrong mode is a named error rather than a silent fallback to
  // `off`: an operator who wrote `deny` and got `off` would believe their
  // unattended sessions answer themselves when they still hang.
  const asApprovalConfig = (raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const mode = raw.mode === undefined ? "off" : raw.mode;
    if (!APPROVAL_MODES.includes(mode)) return undefined;
    const deadlineMs = raw.deadlineMs === undefined ? DEFAULTS.approvals.deadlineMs : raw.deadlineMs;
    if (!Number.isInteger(deadlineMs) || deadlineMs < MIN_APPROVAL_DEADLINE_MS || deadlineMs > MAX_APPROVAL_DEADLINE_MS) {
      return undefined;
    }
    return { mode, deadlineMs };
  };

  const config = {
    enabled: take("enabled", asBoolean, "expected a boolean"),
    token: take("token", asString, "expected a string"),
    tokenFile: take("tokenFile", asString, "expected a string"),
    path: take("path", asString, "expected a string"),
    allowRemote: take("allowRemote", asBoolean, "expected a boolean"),
    defaultCwd: take("defaultCwd", asString, "expected a string"),
    defaultAgentPreset: take("defaultAgentPreset", asString, "expected a string"),
    defaultTimeoutMs: take("defaultTimeoutMs", asPositiveInt, "expected a positive integer (milliseconds)"),
    maxWaitSliceMs: take("maxWaitSliceMs", asPositiveInt, "expected a positive integer (milliseconds)"),
    historyBudgetMs: take("historyBudgetMs", asPositiveInt, "expected a positive integer (milliseconds)"),
    maxBodyBytes: take("maxBodyBytes", asPositiveInt, "expected a positive integer (bytes)"),
    maxSessions: take("maxSessions", asPositiveInt, "expected a positive integer"),
    logRequests: take("logRequests", asBoolean, "expected a boolean"),
    approvals: take(
      "approvals",
      asApprovalConfig,
      'expected an object like { mode: "off" | "deny" | "delegate", deadlineMs?: integer milliseconds }',
    ),
  };

  // Clamp rather than fail: see MAX_WAIT_SLICE_MS. The requested value is kept
  // only when it was changed, so `dsh.discover` can report both and an operator
  // can see why the effective number differs from the configured one.
  if (Number.isInteger(config.maxWaitSliceMs)) {
    const requested = config.maxWaitSliceMs;
    const clamped = Math.min(Math.max(requested, MIN_WAIT_SLICE_MS), MAX_WAIT_SLICE_MS);
    if (clamped !== requested) {
      config.maxWaitSliceMs = clamped;
      config.maxWaitSliceMsRequested = requested;
    }
  }

  if (Number.isInteger(config.historyBudgetMs)) {
    const requested = config.historyBudgetMs;
    const clamped = Math.min(Math.max(requested, MIN_HISTORY_BUDGET_MS), MAX_HISTORY_BUDGET_MS);
    if (clamped !== requested) {
      config.historyBudgetMs = clamped;
      config.historyBudgetMsRequested = requested;
    }
  }

  if (typeof config.path === "string") {
    let path = config.path.startsWith("/") ? config.path : `/${config.path}`;
    while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    if (path === "/") problems.push("path: must not be the site root");
    if (/[\s?#]/.test(path)) problems.push("path: must not contain whitespace, '?' or '#'");
    // A dot segment would never match a registered route and can only be a
    // mistake or an attempt to reach outside the mount point.
    if (path.split("/").some((segment) => segment === "." || segment === "..")) {
      problems.push("path: must not contain '.' or '..' segments");
    }
    config.path = path;
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** Public projection: never leak the shared secret through `dsh.ping`. */
export function describeConfig(config) {
  return {
    enabled: config.enabled,
    path: config.path,
    allowRemote: config.allowRemote,
    defaultCwd: config.defaultCwd || null,
    defaultAgentPreset: config.defaultAgentPreset || null,
    defaultTimeoutMs: config.defaultTimeoutMs,
    historyBudgetMs: config.historyBudgetMs,
    maxWaitSliceMs: config.maxWaitSliceMs,
    ...(config.maxWaitSliceMsRequested === undefined
      ? {}
      : { maxWaitSliceMsRequested: config.maxWaitSliceMsRequested }),
    maxBodyBytes: config.maxBodyBytes,
    maxSessions: config.maxSessions,
    approvals: {
      mode: config.approvals?.mode ?? "off",
      deadlineMs: config.approvals?.deadlineMs ?? DEFAULTS.approvals.deadlineMs,
    },
  };
}
