// Manual config resolution. The plugin deliberately exports no `Config` schema,
// so it carries zero runtime and peer dependencies: a bundle that has to be
// installed into a profile must not need `@deepseek-ai/schemastery` to resolve.
// Validation is therefore explicit, and every failure names the offending key.

import { isTraceLevel, normalizeTraceLevel, type TraceLevel } from "./trace-format.mjs";

export const APPROVAL_MODES = ["off", "deny", "delegate"] as const;
export type ConfigApprovalMode = (typeof APPROVAL_MODES)[number];

export const TASKS_EXTERNAL_ADAPTERS = Object.freeze(["none", "antigravity", "codex"] as const);
export type TasksExternalAdapterKind = (typeof TASKS_EXTERNAL_ADAPTERS)[number];

export interface ApprovalConfig {
  mode: ConfigApprovalMode | string;
  deadlineMs: number;
}

export interface TaskAdapterConfig {
  enabled?: boolean;
  adapterConfigRef?: string;
  binary?: string;
  projectId?: string;
  model?: string;
  [key: string]: unknown;
}

export interface ResolvedConfig {
  enabled: boolean;
  token?: string;
  tokenFile?: string;
  path: string;
  allowRemote: boolean;
  defaultCwd: string;
  defaultAgentPreset: string;
  defaultTimeoutMs: number;
  maxWaitSliceMs: number;
  maxWaitSliceMsRequested?: number;
  historyBudgetMs: number;
  historyBudgetMsRequested?: number;
  maxBodyBytes: number;
  maxSessions: number;
  logRequests?: boolean;
  traceDefault: TraceLevel;
  traceDefaultRequested?: unknown;
  maxResultChars: number;
  timeoutAdvice: boolean;
  approvals: ApprovalConfig;
  tasksDbPath: string | null;
  tasksProbeTimeoutMs: number;
  tasksPreviewTtlMs: number;
  tasksAdapters: Record<string, TaskAdapterConfig>;
  tasksDispatchMaxSteps: number;
  tasksEnabled: boolean;
  tasksMaxConcurrent: number;
  tasksRequireReconcileOnUnknown: boolean;
  tasksExternalAdapter: string;
  tasksAdapterDebugDetail: boolean;
  tasksAutopilot: boolean;
  tasksAutopilotIntervalMs: number;
  tasksAutopilotMaxStart: number;
  tasksAutopilotMaxPump: number;
  tasksWorkspaceRoot: string;
}

export interface DescribedConfig {
  enabled: boolean;
  path: string;
  allowRemote: boolean;
  defaultCwd: string | null;
  defaultAgentPreset: string | null;
  defaultTimeoutMs: number;
  historyBudgetMs: number;
  maxWaitSliceMs: number;
  maxWaitSliceMsRequested?: number;
  historyBudgetMsRequested?: number;
  maxBodyBytes: number;
  maxSessions: number;
  traceDefault: string;
  traceDefaultRequested?: unknown;
  maxResultChars: number;
  timeoutAdvice: boolean;
  approvals: {
    mode: string;
    deadlineMs: number;
  };
  tasksDbPath: string | null;
  tasksProbeTimeoutMs: number;
  tasksPreviewTtlMs: number;
  tasksAdapters: Record<string, TaskAdapterConfig>;
  tasksDispatchMaxSteps: number;
  tasksEnabled: boolean;
  tasksMaxConcurrent: number;
  tasksRequireReconcileOnUnknown: boolean;
  tasksExternalAdapter: string;
  tasksAdapterDebugDetail: boolean;
  tasksAutopilot: boolean;
  tasksAutopilotIntervalMs: number;
  tasksAutopilotMaxStart: number;
  tasksAutopilotMaxPump: number;
  tasksWorkspaceRoot: string | null;
}

const DEFAULTS: ResolvedConfig = {
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
  traceDefault: "errors",
  maxResultChars: 20_000,
  timeoutAdvice: true,
  // `off` keeps the Host's own fail-closed behaviour. `deny` makes this bridge
  // answer for the sessions it created, so an unattended turn is told "no"
  // instead of waiting for a human who is not there. See lib/approvals.mjs.
  approvals: Object.freeze({ mode: "off", deadlineMs: 60_000 }),
  tasksDbPath: null,
  tasksProbeTimeoutMs: 5_000,
  tasksPreviewTtlMs: 300_000,
  tasksAdapters: Object.freeze({}),
  tasksDispatchMaxSteps: 50,
  tasksEnabled: false,
  tasksMaxConcurrent: 1,
  tasksRequireReconcileOnUnknown: true,
  tasksExternalAdapter: "none",
  tasksAdapterDebugDetail: false,
  // The task centre has no caller-facing dispatch/pump: the machine side drives the
  // ledger itself. `false` turns that off and every task waits for a manual
  // `tasks dispatch` / `tasks pump`.
  tasksAutopilot: true,
  tasksAutopilotIntervalMs: 5_000,
  tasksAutopilotMaxStart: 2,
  tasksAutopilotMaxPump: 4,
  // Which tree this bridge's tasks belong to. Sessions started by an external executor
  // inherit it as their cwd, which is what decides the project they show up under in that
  // executor's own window. Empty keeps the historical behaviour (the Host's cwd).
  tasksWorkspaceRoot: "",
};

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

/**
 * Character budget for the MCP turn prose block (`session + text + meta`).
 * `0` disables truncation; positive values guard against pathological outputs.
 */
export const MAX_RESULT_CHARS = 200_000;
export const MIN_RESULT_CHARS = 0;

export const MIN_TASKS_PROBE_TIMEOUT_MS = 100;
export const MAX_TASKS_PROBE_TIMEOUT_MS = 60_000;
export const MIN_TASKS_PREVIEW_TTL_MS = 1_000;
export const MAX_TASKS_PREVIEW_TTL_MS = 3_600_000;
export const MIN_TASKS_DISPATCH_MAX_STEPS = 1;
export const MAX_TASKS_DISPATCH_MAX_STEPS = 1_000;
export const MIN_TASKS_MAX_CONCURRENT = 1;
export const MAX_TASKS_MAX_CONCURRENT = 32;
export const MIN_TASKS_AUTOPILOT_INTERVAL_MS = 1_000;
export const MAX_TASKS_AUTOPILOT_INTERVAL_MS = 600_000;
export const MIN_TASKS_AUTOPILOT_MAX_START = 1;
export const MAX_TASKS_AUTOPILOT_MAX_START = 32;
export const MIN_TASKS_AUTOPILOT_MAX_PUMP = 1;
export const MAX_TASKS_AUTOPILOT_MAX_PUMP = 200;

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`invalid dsh-rpc config: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function resolveConfig(input: Record<string, unknown> | null | undefined = {}): ResolvedConfig {
  if (input === null || input === undefined) input = {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigError(["config must be an object"]);
  }

  const problems: string[] = [];
  const take = <K extends keyof ResolvedConfig>(
    key: K,
    check: (raw: unknown) => ResolvedConfig[K] | undefined,
    message: string,
  ): ResolvedConfig[K] => {
    const raw = input[key as string];
    if (raw === undefined) return DEFAULTS[key];
    const value = check(raw);
    if (value === undefined) problems.push(`${String(key)}: ${message}`);
    return value as ResolvedConfig[K];
  };

  const asBoolean = (raw: unknown): boolean | undefined => (typeof raw === "boolean" ? raw : undefined);
  const asString = (raw: unknown): string | undefined => (typeof raw === "string" ? raw.trim() : undefined);
  const asPositiveInt = (raw: unknown): number | undefined =>
    typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
  const asResultChars = (raw: unknown): number | undefined =>
    typeof raw === "number" && Number.isInteger(raw) && raw >= MIN_RESULT_CHARS && raw <= MAX_RESULT_CHARS
      ? raw
      : undefined;
  const asNullablePath = (raw: unknown): string | null | undefined => {
    if (raw === null) return null;
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  };
  const asBoundedInt =
    (min: number, max: number) =>
    (raw: unknown): number | undefined =>
      typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max ? raw : undefined;
  const asAdaptersMap = (raw: unknown): Record<string, TaskAdapterConfig> | undefined => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const out: Record<string, TaskAdapterConfig> = {};
    for (const [kind, entry] of Object.entries(raw)) {
      if (!kind.trim() || entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return undefined;
      }
      const rec = entry as Record<string, unknown>;
      const enabled = rec.enabled === undefined ? true : rec.enabled;
      if (typeof enabled !== "boolean") return undefined;
      const clean: TaskAdapterConfig = { enabled };
      for (const strKey of ["adapterConfigRef", "binary", "projectId", "model"] as const) {
        if (rec[strKey] !== undefined) {
          if (typeof rec[strKey] !== "string") return undefined;
          clean[strKey] = (rec[strKey] as string).trim();
        }
      }
      out[kind.trim()] = clean;
    }
    return out;
  };

  // `{ mode, deadlineMs }` is the only shape today, so a partial object is
  // accepted and a wrong mode is a named error rather than a silent fallback to
  // `off`: an operator who wrote `deny` and got `off` would believe their
  // unattended sessions answer themselves when they still hang.
  const asApprovalConfig = (raw: unknown): ApprovalConfig | undefined => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const obj = raw as Record<string, unknown>;
    const mode = obj.mode === undefined ? "off" : obj.mode;
    if (typeof mode !== "string" || !(APPROVAL_MODES as readonly string[]).includes(mode)) return undefined;
    const deadlineMs = obj.deadlineMs === undefined ? DEFAULTS.approvals.deadlineMs : obj.deadlineMs;
    if (
      typeof deadlineMs !== "number" ||
      !Number.isInteger(deadlineMs) ||
      deadlineMs < MIN_APPROVAL_DEADLINE_MS ||
      deadlineMs > MAX_APPROVAL_DEADLINE_MS
    ) {
      return undefined;
    }
    return { mode: mode as ConfigApprovalMode, deadlineMs };
  };

  const config: ResolvedConfig = {
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
    traceDefault: DEFAULTS.traceDefault,
    maxResultChars: take(
      "maxResultChars",
      asResultChars,
      `expected an integer between ${MIN_RESULT_CHARS} and ${MAX_RESULT_CHARS}`,
    ),
    timeoutAdvice: take("timeoutAdvice", asBoolean, "expected a boolean"),
    approvals: take(
      "approvals",
      asApprovalConfig,
      'expected an object like { mode: "off" | "deny" | "delegate", deadlineMs?: integer milliseconds }',
    ),
    tasksDbPath: take("tasksDbPath", asNullablePath, "expected a string path or null"),
    tasksProbeTimeoutMs: take(
      "tasksProbeTimeoutMs",
      asBoundedInt(MIN_TASKS_PROBE_TIMEOUT_MS, MAX_TASKS_PROBE_TIMEOUT_MS),
      `expected an integer between ${MIN_TASKS_PROBE_TIMEOUT_MS} and ${MAX_TASKS_PROBE_TIMEOUT_MS}`,
    ),
    tasksPreviewTtlMs: take(
      "tasksPreviewTtlMs",
      asBoundedInt(MIN_TASKS_PREVIEW_TTL_MS, MAX_TASKS_PREVIEW_TTL_MS),
      `expected an integer between ${MIN_TASKS_PREVIEW_TTL_MS} and ${MAX_TASKS_PREVIEW_TTL_MS}`,
    ),
    tasksAdapters: take(
      "tasksAdapters",
      asAdaptersMap,
      "expected a map of { [kind]: { enabled?, adapterConfigRef?, binary?, projectId?, model? } }",
    ),
    tasksDispatchMaxSteps: take(
      "tasksDispatchMaxSteps",
      asBoundedInt(MIN_TASKS_DISPATCH_MAX_STEPS, MAX_TASKS_DISPATCH_MAX_STEPS),
      `expected an integer between ${MIN_TASKS_DISPATCH_MAX_STEPS} and ${MAX_TASKS_DISPATCH_MAX_STEPS}`,
    ),
    tasksEnabled: take("tasksEnabled", asBoolean, "expected a boolean"),
    tasksMaxConcurrent: take(
      "tasksMaxConcurrent",
      asBoundedInt(MIN_TASKS_MAX_CONCURRENT, MAX_TASKS_MAX_CONCURRENT),
      `expected an integer between ${MIN_TASKS_MAX_CONCURRENT} and ${MAX_TASKS_MAX_CONCURRENT}`,
    ),
    tasksRequireReconcileOnUnknown: take("tasksRequireReconcileOnUnknown", asBoolean, "expected a boolean"),
    tasksExternalAdapter: take(
      "tasksExternalAdapter",
      (raw) =>
        typeof raw === "string" && (TASKS_EXTERNAL_ADAPTERS as readonly string[]).includes(raw.trim())
          ? raw.trim()
          : undefined,
      `expected one of ${TASKS_EXTERNAL_ADAPTERS.map((v) => `"${v}"`).join(" | ")}`,
    ),
    tasksAdapterDebugDetail: take("tasksAdapterDebugDetail", asBoolean, "expected a boolean"),
    tasksAutopilot: take("tasksAutopilot", asBoolean, "expected a boolean"),
    tasksAutopilotIntervalMs: take(
      "tasksAutopilotIntervalMs",
      asBoundedInt(MIN_TASKS_AUTOPILOT_INTERVAL_MS, MAX_TASKS_AUTOPILOT_INTERVAL_MS),
      `expected an integer between ${MIN_TASKS_AUTOPILOT_INTERVAL_MS} and ${MAX_TASKS_AUTOPILOT_INTERVAL_MS}`,
    ),
    tasksAutopilotMaxStart: take(
      "tasksAutopilotMaxStart",
      asBoundedInt(MIN_TASKS_AUTOPILOT_MAX_START, MAX_TASKS_AUTOPILOT_MAX_START),
      `expected an integer between ${MIN_TASKS_AUTOPILOT_MAX_START} and ${MAX_TASKS_AUTOPILOT_MAX_START}`,
    ),
    tasksAutopilotMaxPump: take(
      "tasksAutopilotMaxPump",
      asBoundedInt(MIN_TASKS_AUTOPILOT_MAX_PUMP, MAX_TASKS_AUTOPILOT_MAX_PUMP),
      `expected an integer between ${MIN_TASKS_AUTOPILOT_MAX_PUMP} and ${MAX_TASKS_AUTOPILOT_MAX_PUMP}`,
    ),
    tasksWorkspaceRoot: take("tasksWorkspaceRoot", asString, "expected a string"),
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

  if (input.traceDefault !== undefined) {
    config.traceDefault = normalizeTraceLevel(input.traceDefault, DEFAULTS.traceDefault);
    if (!isTraceLevel(input.traceDefault)) {
      config.traceDefaultRequested = input.traceDefault;
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
export function describeConfig(config: Partial<ResolvedConfig>): DescribedConfig {
  return {
    enabled: config.enabled ?? DEFAULTS.enabled,
    path: config.path ?? DEFAULTS.path,
    allowRemote: config.allowRemote ?? DEFAULTS.allowRemote,
    defaultCwd: config.defaultCwd || null,
    defaultAgentPreset: config.defaultAgentPreset || null,
    defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs,
    historyBudgetMs: config.historyBudgetMs ?? DEFAULTS.historyBudgetMs,
    maxWaitSliceMs: config.maxWaitSliceMs ?? DEFAULTS.maxWaitSliceMs,
    ...(config.maxWaitSliceMsRequested === undefined
      ? {}
      : { maxWaitSliceMsRequested: config.maxWaitSliceMsRequested }),
    maxBodyBytes: config.maxBodyBytes ?? DEFAULTS.maxBodyBytes,
    maxSessions: config.maxSessions ?? DEFAULTS.maxSessions,
    traceDefault: config.traceDefault ?? DEFAULTS.traceDefault,
    ...(config.traceDefaultRequested === undefined
      ? {}
      : { traceDefaultRequested: config.traceDefaultRequested }),
    maxResultChars: config.maxResultChars ?? DEFAULTS.maxResultChars,
    timeoutAdvice: config.timeoutAdvice ?? DEFAULTS.timeoutAdvice,
    approvals: {
      mode: config.approvals?.mode ?? "off",
      deadlineMs: config.approvals?.deadlineMs ?? DEFAULTS.approvals.deadlineMs,
    },
    tasksDbPath: config.tasksDbPath ?? null,
    tasksProbeTimeoutMs: config.tasksProbeTimeoutMs ?? DEFAULTS.tasksProbeTimeoutMs,
    tasksPreviewTtlMs: config.tasksPreviewTtlMs ?? DEFAULTS.tasksPreviewTtlMs,
    tasksAdapters: config.tasksAdapters ?? {},
    tasksWorkspaceRoot: config.tasksWorkspaceRoot || null,
    tasksDispatchMaxSteps: config.tasksDispatchMaxSteps ?? DEFAULTS.tasksDispatchMaxSteps,
    tasksEnabled: config.tasksEnabled ?? DEFAULTS.tasksEnabled,
    tasksMaxConcurrent: config.tasksMaxConcurrent ?? DEFAULTS.tasksMaxConcurrent,
    tasksRequireReconcileOnUnknown:
      config.tasksRequireReconcileOnUnknown ?? DEFAULTS.tasksRequireReconcileOnUnknown,
    tasksExternalAdapter: config.tasksExternalAdapter ?? DEFAULTS.tasksExternalAdapter,
    tasksAdapterDebugDetail: config.tasksAdapterDebugDetail ?? DEFAULTS.tasksAdapterDebugDetail,
    tasksAutopilot: config.tasksAutopilot ?? DEFAULTS.tasksAutopilot,
    tasksAutopilotIntervalMs: config.tasksAutopilotIntervalMs ?? DEFAULTS.tasksAutopilotIntervalMs,
    tasksAutopilotMaxStart: config.tasksAutopilotMaxStart ?? DEFAULTS.tasksAutopilotMaxStart,
    tasksAutopilotMaxPump: config.tasksAutopilotMaxPump ?? DEFAULTS.tasksAutopilotMaxPump,
  };
}
