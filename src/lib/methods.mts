// Method implementations over the Host `sessionController` service.
//
// The whole bridge rests on one observation: `sessionController.follow` is an
// AsyncIterable whose first frame is a snapshot and whose later frames are live
// events. Subscribing *before* `prompt` is admitted is what makes the result
// deterministic — we know the turn baseline first, so the turn we are waiting
// for is exactly `baseline.turn + 1` (or `baseline.turn` for a steer into a
// running turn). No polling, no racing the queue.

import { createHash, randomUUID } from "node:crypto";

// split-imports:begin
import {
  ASK_MODES,
  ActiveRunRecord,
  AgentsGetParams,
  AgentsGetResult,
  AgentsListItem,
  AgentsListParams,
  AgentsListResult,
  AgentsProbeParams,
  AgentsProbeResult,
  AgentsRegisterParams,
  AgentsRegisterResult,
  ApprovalsPendingParams,
  ApprovalsPendingResult,
  ApprovalsResolveParams,
  ApprovalsResolveResult,
  ApprovalsServiceLike,
  AskMode,
  BridgeRuntimeStateLike,
  CapabilitiesParams,
  CapabilitiesResult,
  CollectedToolCall,
  CollectedTurnResult,
  CreateMethodsDeps,
  DEFAULT_HISTORY_BUDGET_MS,
  DiscoverParams,
  DiscoverResult,
  ESCALATION_PRESET,
  HostServiceContextLike,
  ITERATOR_RETURN_MS,
  MAX_TIMEOUT_MS,
  MAX_WAIT_RECORDS,
  MIN_TIMEOUT_MS,
  MethodCatalogEntrySpec,
  ModelsParams,
  ModelsResult,
  PRESET_COST,
  PermissionsCatalogParams,
  PermissionsCatalogResult,
  PingParams,
  PingResult,
  ProjectedSessionEvent,
  REUSE_MODES,
  RegisteredCapabilityRevision,
  SANDBOX_DENIED_MARKER,
  SelectedModel,
  SessionControllerFollowFrame,
  SessionControllerLike,
  SessionControllerListedItem,
  SessionsAskParams,
  SessionsAskResult,
  SessionsCancelParams,
  SessionsCancelResult,
  SessionsConfigureParams,
  SessionsConfigureResult,
  SessionsCreateParams,
  SessionsCreateResult,
  SessionsHistoryParams,
  SessionsHistoryResult,
  SessionsListParams,
  SessionsListResult,
  SessionsPromptParams,
  SessionsPromptResult,
  SessionsWaitParams,
  SessionsWaitResult,
  TOOL_OUTPUT_BUDGET,
  TOOL_OUTPUT_LIMIT,
  TasksCancelParams,
  TasksCancelResult,
  TasksDecideApprovalParams,
  TasksDecideApprovalResult,
  TasksDispatchParams,
  TasksDispatchResult,
  TasksEventsParams,
  TasksEventsResult,
  TasksGetParams,
  TasksGetResult,
  TasksInputParams,
  TasksInputResult,
  TasksListParams,
  TasksListResult,
  TasksPreviewParams,
  TasksPreviewResult,
  TasksPumpParams,
  TasksPumpResult,
  TasksReadArtifactParams,
  TasksReadArtifactResult,
  TasksReconcileParams,
  TasksReconcileResult,
  TasksResolveParams,
  TasksResolveResult,
  TasksSubmitParams,
  TasksSubmitResult,
  TokenUsage,
  TurnEndReason,
  WebServerLike,
  WorkspaceProjection,
  WorkspacesCreateParams,
  WorkspacesCreateResult,
  WorkspacesListParams,
  WorkspacesListResult,
  closeWithin,
  nextWithin,
} from "./methods/types.mjs";
import {
  ALLOWED_ADAPTER_KINDS,
  CreateMethodsResult,
  METHOD_CATALOG,
  MethodCatalogEntry,
  MethodName,
  RpcMethodHandler,
  TASK_FAMILY_METHODS,
  readSessionSnapshot,
} from "./methods/catalog.mjs";
import {
  AcquiredStickyResult,
  LoggerLike,
  PreparedStickyOptions,
  PromptSlot,
  StickyLock,
  StickyReservation,
  createDshAdapterOps,
} from "./methods/adapter-ops.mjs";
import {
  applyMaxCharsToRecords,
  collectTurn,
  findTurnEnd,
  hasAnswerFor,
  logger,
  maxTurn,
  num,
  originOf,
  projectEvent,
  reasonForEnd,
  safeJson,
  sandboxDenial,
  statusFromReason,
  summarizeRecords,
  timeOfItem,
  withinPath,
} from "./methods/helpers.mjs";
// split-imports:end

import { createDshAdapter, type DshSessionOps } from "./adapters/dsh.mjs";
import {
  CONTROL_NAMES,
  capabilityRevisionId,
  hashCard,
  normalizeCard,
  withVerified,
  type ControlName,
  type NormalizedCard,
  type VerifiedCard,
} from "./agents/card.mjs";
import { createProber, type ProbeMap, type ProbeUnknownEntry } from "./agents/probe.mjs";
import {
  formatCapabilities,
  MAX_MAX_CHARS,
  normalizeSections,
  type NormalizedCapabilitySection,
} from "./capabilities.mjs";
import { describeConfig, type DescribedConfig, type ResolvedConfig } from "./config.mjs";
import { collectFacts } from "./host-facts.mjs";
import { type RpcDispatchContext } from "./http.mjs";
import { isOwnedSession, ownSession } from "./owned.mjs";
import { CODE, RpcError, badRequest } from "./protocol.mjs";
import { ROTATE_AFTER_ASKS, lookupEntry, registryKey, rememberEntry } from "./registry.mjs";
import type { PendingApprovalPacket } from "./pending.mjs";
import { createTaskEngine, type TaskDetail, type TaskEngine, type TaskEventsResult } from "./tasks/engine.mjs";
import { createDispatcher, type Dispatcher, type PumpResult, type StartTaskResult } from "./tasks/dispatch.mjs";
import { notFoundError, validationFailed } from "./tasks/errors.mjs";
import { createPreview, type CreatePreviewResult } from "./tasks/preview.mjs";
import {
  reconcileTask as applyReconcileTask,
  type ReconcileEvidence,
  type ReconcileTaskParams,
  type ReconcileTaskResult,
} from "./tasks/reconcile.mjs";
import { openStore, type AgentRow, type CapabilityRevisionRow, type TaskStore } from "./tasks/store.mjs";
import { type TaskStatus } from "./tasks/state-machine.mjs";
import { PLUGIN_NAME, PLUGIN_VERSION, PROTOCOL_VERSION } from "./version.mjs";

// ------------------------------------------------------------------ types --

export function createMethods(
  {
    sessionController,
    webServer,
    approvals = null,
    taskStore = null,
    taskEngine = null,
    agentProbes = null,
    adapters = null,
    taskDispatcher = null,
    taskCentre = null,
  }: CreateMethodsDeps,
  config: Partial<ResolvedConfig> = {},
  ctx: HostServiceContextLike = {},
  state: BridgeRuntimeStateLike = {},
): CreateMethodsResult {
  const log = logger(ctx);
  let ownedTaskStore: TaskStore | null = taskStore;
  let resolvedTaskEngine: TaskEngine | null = taskEngine;
  let resolvedTaskDispatcher: Dispatcher | null = taskDispatcher;
  function getTaskStore(): TaskStore {
    if (resolvedTaskEngine?.store) return resolvedTaskEngine.store;
    if (!ownedTaskStore) {
      // Falling back here means the Host wiring did not hand us a store. That is a
      // degraded mode, not a normal one: record it so ping() can say so.
      ownedTaskStore = openStore({ path: config?.tasksDbPath || ":memory:" });
      if (taskCentre) {
        taskCentre.mode = config?.tasksDbPath ? "file-lazy" : "memory";
        taskCentre.lazyStore = true;
      }
    }
    return ownedTaskStore;
  }
  function getTaskEngine(): TaskEngine {
    if (resolvedTaskEngine) return resolvedTaskEngine;
    resolvedTaskEngine = createTaskEngine(getTaskStore());
    return resolvedTaskEngine;
  }
  function getTaskDispatcher(): Dispatcher {
    if (resolvedTaskDispatcher) return resolvedTaskDispatcher;
    const resolvedAdapters: Record<string, unknown> = { ...(adapters ?? {}) };
    if (config?.tasksEnabled && !resolvedAdapters.dsh) {
      resolvedAdapters.dsh = createDshAdapter({
        ops: createDshAdapterOps({ sessionController, config, ctx, approvals }),
      });
    }
    resolvedTaskDispatcher = createDispatcher({
      store: getTaskStore(),
      engine: getTaskEngine(),
      adapters: resolvedAdapters as Record<string, never>,
      maxConcurrent: config?.tasksMaxConcurrent ?? 1,
      logger: log,
      debugRawAdapterErrors: config?.tasksAdapterDebugDetail === true,
    });
    return resolvedTaskDispatcher;
  }
  const runs = new Map<string, ActiveRunRecord>();
  /** sessionId → runId of the run that owns prompting on that session. */
  const prompting = new Map<string, PromptSlot>();
  /** In-process serialization and reservations for sticky session acquisition. */
  const stickyLocks = new Map<string, StickyLock>();
  const stickySessions = new Map<string, StickyReservation>();

  async function withStickyLock<T>(key: string, operation: (lock: StickyLock) => Promise<T>): Promise<T> {
    let lock = stickyLocks.get(key);
    if (!lock) {
      lock = { tail: Promise.resolve(), waiters: 0 };
      stickyLocks.set(key, lock);
    }
    lock.waiters += 1;
    const previous = lock.tail;
    let release!: () => void;
    lock.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation(lock);
    } finally {
      lock.waiters -= 1;
      release();
      if (lock.waiters === 0 && stickyLocks.get(key) === lock) stickyLocks.delete(key);
    }
  }

  async function releaseStickySession(key: string | null, reservation: StickyReservation | null): Promise<void> {
    if (!key || !reservation) return;
    await withStickyLock(key, async () => {
      if (stickySessions.get(key) !== reservation) return;
      reservation.inFlight -= 1;
      if (reservation.inFlight <= 0) reservation.inFlight = 0;
    });
  }

  // Host Remote methods dereference the caller signal unconditionally
  // (`signal.throwIfAborted()` in @deepseek-ai/dsh-api-session-controller), so
  // even one-shot calls must hand over a real AbortSignal rather than undefined.
  const IDLE_SIGNAL = new AbortController().signal;

  const controller = (): SessionControllerLike => {
    if (!sessionController) {
      throw new RpcError(CODE.internal, "sessionController service is unavailable");
    }
    return sessionController;
  };

  // ---------------------------------------------------------------- helpers --

  function clampTimeout(value: unknown): number {
    const requested = typeof value === "number" && Number.isInteger(value) ? value : (config.defaultTimeoutMs as number);
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, requested));
  }

  /**
   * The most a single response may wait for. Anything longer is answered at the
   * slice boundary with `status: "timeout"` plus `sliceMs`, and the caller asks
   * again — see `waitForTurn()` in lib/client.mjs. This is not politeness: the
   * transport aborts the request first, and then nobody gets an answer at all.
   */
  function sliceTimeout(value: unknown): number {
    return Math.min(clampTimeout(value), config.maxWaitSliceMs as number);
  }

  function requireText(value: unknown, key: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw badRequest(`\`${key}\` must be a non-empty string`);
    }
    return value;
  }

  function optionalString(value: unknown, key: string): string {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string") throw badRequest(`\`${key}\` must be a string`);
    return value.trim();
  }

  function requireSessionId(value: unknown, key = "sessionId"): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw badRequest(`\`${key}\` must be a non-empty session id`);
    }
    return value.trim();
  }

  /**
   * `limit` is a positive integer or absent. Coercing a fractional or negative
   * value into "1 row" hides a caller's bug and looks like a different result
   * set, so a bad value is rejected the same way a bad `sessionId` is.
   */
  function optionalLimit(value: unknown, { max = Number.MAX_SAFE_INTEGER, fallback }: { max?: number; fallback: number }): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw badRequest("`limit` must be a positive integer");
    }
    return Math.min(value, max);
  }

  function optionalNonNegInt(value: unknown, key: string): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw badRequest(`\`${key}\` must be a non-negative integer`);
    }
    return value;
  }

  function optionalKinds(value: unknown): Set<string> | null {
    if (value === undefined || value === null || value === "*") return null;
    if (!Array.isArray(value)) {
      throw badRequest('`kinds` must be an array of event types or "*"');
    }
    for (const item of value) {
      if (typeof item !== "string" || item.trim().length === 0) {
        throw badRequest('`kinds` entries must be non-empty strings');
      }
    }
    if (value.includes("*")) return null;
    return new Set(value);
  }

  /**
   * One of `allowed`, or the default when absent. Anything else is refused: a
   * typo in `mode` must not silently fall back to a different concurrency rule.
   */
  function optionalChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T, key: string): T {
    const text = optionalString(value, key);
    if (!text) return fallback;
    if (!(allowed as readonly string[]).includes(text)) {
      throw badRequest(`\`${key}\` must be one of ${allowed.map((one) => `"${one}"`).join(", ")}; got "${text}"`);
    }
    return text as T;
  }

  /**
   * Where a new session should live: a registered workspace, or a directory.
   *
   * The Host rejects `workspaceId` + `cwd` together, so the rule is enforced here
   * first with a message a caller can act on. `config.defaultCwd` is a fallback for
   * the directory case only — it must not collide with a workspace the caller named.
   */
  function createTarget(params: Record<string, unknown> = {}): { workspaceId: string; cwd: string } {
    const workspaceId = optionalString(params.workspaceId, "workspaceId");
    const explicitCwd = optionalString(params.cwd, "cwd");
    if (workspaceId && explicitCwd) {
      throw badRequest("`workspaceId` and `cwd` cannot be combined; name one of them");
    }
    return { workspaceId, cwd: workspaceId ? "" : explicitCwd || (config.defaultCwd ?? "") };
  }

  /**
   * Create a session.
   *
   * The Host resolves its own project directory when the request names no `cwd`
   * (`workspace?.path ?? request.cwd ?? this.defaultCwd`), so this never
   * substitutes `process.cwd()`: that is the Harness profile directory, not a
   * workspace the user chose. The resolved directory is read back from the Host
   * instead of being guessed, because `create` returns only an id.
   *
   * A `workspaceId` makes the Host attach the session to that workspace
   * (`workspace.attachSession`), which is what puts it under that workspace in the
   * sidebar — a plain `cwd` only sets the directory.
   */
  async function createSession(params: Record<string, unknown> = {}): Promise<SessionsCreateResult> {
    // Session ids are the Host's to assign. Accepting one here and then quietly
    // returning a different id would read like the request had been honoured — the
    // one failure mode a caller cannot detect from the reply.
    if (optionalString(params.sessionId, "sessionId")) {
      throw badRequest(
        "`sessionId` is assigned by the Host: drop it to create a new session, or pass it to dsh.sessions.ask to continue an existing one",
      );
    }
    const { workspaceId, cwd } = createTarget(params);
    const preset = optionalString(params.agentPreset, "agentPreset") || config.defaultAgentPreset;
    const request: Record<string, unknown> = {};
    if (workspaceId) request.workspaceId = workspaceId;
    if (cwd) request.cwd = cwd;
    if (preset) request.agentPreset = preset;
    const value = await controller().create(request);
    const sessionId = value?.sessionId as string;
    // Ownership is what lets the approval answerer speak for this session at
    // all (lib/owned.mjs). Marked here rather than in `ask`, because `ask`
    // creates through this same helper and every creation path must register.
    ownSession(sessionId);
    const applied = await applySessionOptions(sessionId, params);
    return {
      sessionId,
      agentPreset: value?.agentPreset ?? (preset || null),
      cwd: await inspectCwd(sessionId),
      ...applied,
    };
  }

  /** Read back the directory the Host attached to a session, without activating it. */
  async function inspectCwd(sessionId: string): Promise<string | null> {
    if (!sessionId) return null;
    try {
      const inspection = await controller().inspect?.(sessionId, IDLE_SIGNAL);
      const cwd = inspection?.meta?.cwd;
      return typeof cwd === "string" ? cwd : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------- model, effort, permission --

  /**
   * A bare model id is accepted when exactly one provider offers it; `provider/id`
   * always works. Ambiguity is reported with the spellings that would resolve it,
   * because picking one silently would send the caller's turn to a different
   * provider than the one they had in mind.
   */
  async function resolveModel(model: string): Promise<{ provider: string; model: string }> {
    const slash = model.indexOf("/");
    if (slash > 0) {
      return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
    }
    const catalog = await controller().modelCatalog?.();
    const hits: Array<{ provider: string; model: string }> = [];
    for (const group of catalog?.groups ?? []) {
      for (const entry of group.models ?? []) {
        if (entry?.id === model) hits.push({ provider: group.id, model: entry.id });
      }
    }
    // hits.length === 1 checked immediately above.
    if (hits.length === 1) return hits[0] as { provider: string; model: string };
    if (hits.length === 0) {
      throw badRequest(`unknown model "${model}"; call dsh.models for the routable ids`);
    }
    throw badRequest(
      `model "${model}" is offered by ${hits.map((hit) => hit.provider).join(", ")}; spell it "provider/${model}"`,
    );
  }

  /**
   * Model and permission belong to the Session, not to the create request, so they
   * are installed right after creation (or before the next prompt) through the
   * Host's own setters — the bridge invents no knobs of its own.
   *
   * `selectModel` also saves the choice as the profile default in the background.
   * That is the Host's own behaviour for a model switch, and it means a caller who
   * sets a model here changes what the next GUI session starts with. Documented
   * rather than hidden.
   */
  async function prepareStickySessionOptions(params: Record<string, unknown> = {}): Promise<PreparedStickyOptions> {
    const model = optionalString(params.model, "model");
    const effort = optionalString(params.reasoningEffort, "reasoningEffort");
    const permissionPreset = optionalString(params.permissionPreset, "permissionPreset");
    const target = model ? await resolveModel(model) : null;
    if (!model && effort) {
      // The Host setter takes a full selection; without a model there is nothing
      // to attach the effort to, and reading the session's current model back is
      // not exposed. Refuse with the reason instead of guessing.
      throw badRequest("`reasoningEffort` needs `model` in the same request");
    }

    if (permissionPreset) await validatePermissionPreset(permissionPreset);
    return { target, effort, permissionPreset };
  }

  async function applyPreparedStickyOptions(
    sessionId: string,
    prepared: PreparedStickyOptions,
  ): Promise<{ selected?: SelectedModel; permissionPreset?: string }> {
    const applied: { selected?: SelectedModel; permissionPreset?: string } = {};
    const { target, effort, permissionPreset } = prepared;
    if (permissionPreset) {
      await validatePermissionPreset(permissionPreset);
      validatePermissionPresetAccess(sessionId, permissionPreset);
    }
    if (target) {
      const value = await controller().selectModel?.({
        sessionId,
        provider: target.provider,
        model: target.model,
        ...(effort ? { reasoningEffort: effort } : {}),
      });
      applied.selected = value?.selected ?? { ...target, ...(effort ? { reasoningEffort: effort } : {}) };
    }
    if (permissionPreset) {
      const session = await liveSession(sessionId);
      permissionPresets().set(session, permissionPreset);
      applied.permissionPreset = permissionPreset;
    }
    return applied;
  }

  async function applySessionOptions(
    sessionId: string,
    params: Record<string, unknown> = {},
  ): Promise<{ selected?: SelectedModel; permissionPreset?: string }> {
    const applied: { selected?: SelectedModel; permissionPreset?: string } = {};
    const model = optionalString(params.model, "model");
    const effort = optionalString(params.reasoningEffort, "reasoningEffort");
    const permissionPreset = optionalString(params.permissionPreset, "permissionPreset");

    if (model) {
      const target = await resolveModel(model);
      const value = await controller().selectModel?.({
        sessionId,
        provider: target.provider,
        model: target.model,
        ...(effort ? { reasoningEffort: effort } : {}),
      });
      applied.selected = value?.selected ?? { ...target, ...(effort ? { reasoningEffort: effort } : {}) };
    } else if (effort) {
      throw badRequest("`reasoningEffort` needs `model` in the same request");
    }

    if (permissionPreset) applied.permissionPreset = await applyPermissionPreset(sessionId, permissionPreset);
    return applied;
  }

  /**
   * The pending-approval store, or a named error. It only exists when
   * `approvals.mode` delegates: `off` and `deny` never hold a call, so there is
   * nothing to ask about.
   */
  function approvalsStore(): ApprovalsServiceLike & {
    waitForAny: NonNullable<ApprovalsServiceLike["waitForAny"]>;
  } {
    if (!approvals || typeof approvals.open !== "function") {
      throw new RpcError(
        CODE.server,
        "this bridge is not holding approvals: set approvals.mode to \"delegate\" to answer escalations from callers",
      );
    }
    return approvals as ApprovalsServiceLike & {
      waitForAny: NonNullable<ApprovalsServiceLike["waitForAny"]>;
    };
  }

  function permissionPresets(): {
    catalog?: () => Promise<{
      defaultPreset?: string | null;
      options?: Array<{ value: string; name: string; description?: string | null }>;
      defaultOptions?: Array<{ value: string }>;
    }>;
    set(session: unknown, name: string): void;
  } {
    const service = ctx.get?.("permissionPresets") as
      | {
          catalog?: () => Promise<{
            defaultPreset?: string | null;
            options?: Array<{ value: string; name: string; description?: string | null }>;
            defaultOptions?: Array<{ value: string }>;
          }>;
          set(session: unknown, name: string): void;
        }
      | undefined;
    if (!service) {
      throw new RpcError(
        CODE.server,
        "this Harness deployment exposes no permissionPresets service, so `permissionPreset` cannot be applied",
      );
    }
    return service;
  }

  /** The Host's preset setter wants the live Session object, not an id. */
  async function liveSession(sessionId: string): Promise<unknown> {
    const sessions = ctx.get?.("sessions") as { get?: (id: string) => unknown } | undefined;
    const known = sessions?.get?.(sessionId);
    if (known) return known;
    // A cold Session has no live object until something admits it. `resolveAgent`
    // is the same admission path `prompt` uses, so the preset lands on the Session
    // the next turn will actually run in.
    await controller().resolveAgent?.(sessionId).then((result) => {
      if (result?.error) throw result.error;
    });
    const resumed = (ctx.get?.("sessions") as { get?: (id: string) => unknown } | undefined)?.get?.(sessionId);
    if (!resumed) {
      throw new RpcError(CODE.server, `session ${sessionId} is still not live after resuming`);
    }
    return resumed;
  }

  async function validatePermissionPreset(name: string): Promise<void> {
    const catalog = await permissionPresets().catalog?.();
    const known = (catalog?.options ?? []).map((option) => option.value);
    if (known.length > 0 && !known.includes(name)) {
      throw badRequest(
        `unknown permission preset "${name}"; available: ${known.join(", ")} — after a sandbox denial, ` +
          `"${ESCALATION_PRESET}" is the one documented escalation`,
      );
    }
  }

  function validatePermissionPresetAccess(sessionId: string, name: string): void {
    // A preset change is an escalation route that never passes through the tool
    // gate: `configure`, and a reused `ask`/`prompt`, could otherwise hand a
    // session full access without anybody being asked. Two rules while approvals
    // are configured: only sessions this bridge created may be changed, and
    // raising one to `danger-full-access` has to go through the gate instead.
    if (!isOwnedSession(sessionId)) {
      throw badRequest(
        `session ${sessionId} was not created by this bridge; its permission preset is not this caller's to change`,
      );
    }
    if (config.approvals?.mode !== "off" && name === ESCALATION_PRESET) {
      throw new RpcError(
        CODE.forbidden,
        `refusing to raise a session to "${ESCALATION_PRESET}" by changing its preset while approvals.mode is ` +
          `"${config.approvals?.mode}": let the tool ask for it, and answer that request`,
      );
    }
  }

  async function applyPermissionPreset(sessionId: string, name: string): Promise<string> {
    await validatePermissionPreset(name);
    validatePermissionPresetAccess(sessionId, name);
    const session = await liveSession(sessionId);
    permissionPresets().set(session, name);
    return name;
  }

  /**
   * Internal call options (progress callback, abort signal) travel on a separate
   * channel from user params, so a JSON-RPC caller cannot inject them by naming
   * them in `params`.
   */
  function internalContext(context: RpcDispatchContext | undefined): {
    onEvent: ((frame: unknown) => void) | null;
    signal: AbortSignal | null;
  } {
    return {
      onEvent: typeof context?.onEvent === "function" ? context.onEvent : null,
      signal: context?.signal instanceof AbortSignal ? context.signal : null,
    };
  }

  // ------------------------------------------------------------------ drive --

  /**
   * Resolve when `done` settles, or fail once the caller's remaining budget runs
   * out. Used while waiting for another run to release a session, so that a stuck
   * holder cannot turn into a hung caller: the waiter's own deadline still governs.
   */
  function settleOrDeadline(
    done: Promise<void>,
    remainingMs: number,
    signal: AbortSignal | null,
    sessionId: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (rejectWith: unknown, hasError: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (hasError) reject(rejectWith);
        else resolve();
      };
      const timer = setTimeout(
        () =>
          finish(
            new RpcError(
              CODE.timeout,
              `session ${sessionId} stayed busy for the whole ${remainingMs}ms wait; the run holding it never finished`,
              { sessionId },
            ),
            true,
          ),
        remainingMs,
      );
      timer.unref?.();
      const onAbort = () =>
        finish(new RpcError(CODE.cancelled, "waiting for the session was cancelled", { sessionId }), true);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      done.then(
        () => finish(undefined, false),
        () => finish(undefined, false),
      );
    });
  }

  /**
   * Take the prompting slot for a session, waiting for whoever holds it.
   *
   * Attribution needs one prompting run per session at a time, so a second prompt
   * is refused by default. `queue: true` opts into waiting instead — in arrival
   * order, bounded by the waiter's own deadline.
   *
   * Taking is fused with waiting on purpose. A separate "wait, then install" pair
   * lets two waiters wake on the same release, both observe an empty slot, and
   * both install themselves — the double-prompt state this whole mechanism exists
   * to prevent. Here the check and the install happen in one synchronous turn, so
   * a second waiter always sees the first one's slot and keeps waiting.
   */
  async function takePromptSlot(
    sessionId: string,
    deadlineAt: number,
    signal: AbortSignal | null,
    runId: string,
  ): Promise<PromptSlot> {
    for (;;) {
      const holder = prompting.get(sessionId);
      if (holder === undefined) {
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const slot: PromptSlot = { runId, done, finish };
        prompting.set(sessionId, slot);
        return slot;
      }
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        throw new RpcError(CODE.timeout, `session ${sessionId} is still busy; gave up waiting for its turn`, {
          sessionId,
        });
      }
      await settleOrDeadline(holder.done, remaining, signal, sessionId);
    }
  }

  /**
   * Open the follow stream, optionally admit a prompt, and consume events until
   * the target turn ends. Returns a plain result object; `onEvent` receives the
   * kept events for live progress.
   */
  async function drive(
    sessionId: string,
    options: {
      text?: string | null | undefined;
      mode?: AskMode | undefined;
      queue?: boolean | undefined;
      timeoutMs?: number | undefined;
      onEvent?: ((frame: unknown) => void) | null | undefined;
      maxRecords?: number | undefined;
      signal?: AbortSignal | null | undefined;
      since?: number | null | undefined;
      beforePrompt?: (() => Promise<void>) | null | undefined;
    } = {},
  ): Promise<SessionsAskResult> {
    const {
      text = null,
      mode = "queue",
      queue = false,
      timeoutMs,
      onEvent = null,
      maxRecords = 128,
      signal = null,
      since = null,
      beforePrompt = null,
    } = options;

    // The Host understands two modes (`steer` / `queue`). `turn` is this
    // bridge's own rule — decided from the live baseline below — so it is
    // translated here and never forwarded.
    const hostMode = mode === "steer" ? "steer" : "queue";

    // `since` is a caller's previous cursor: return only what is newer. Absent or
    // malformed values mean "everything this run collected", never an error — a
    // stale cursor must not break a wait.
    const sinceCursor = typeof since === "number" && Number.isInteger(since) && since >= 0 ? since : null;

    if (runs.size >= (config.maxSessions as number)) {
      throw new RpcError(CODE.busy, `too many concurrent bridge runs (limit ${config.maxSessions})`);
    }

    const requestedDeadlineMs = clampTimeout(timeoutMs);
    const deadlineMs = sliceTimeout(timeoutMs);
    const ac = new AbortController();
    const runId = `run-${randomUUID()}`;
    const startedAt = Date.now();
    const deadlineAt = startedAt + deadlineMs;

    // Turn attribution is only sound while this bridge owns the only prompt in
    // flight on the session. A second prompting run would compute the same
    // `baseline + 1` target and could return the first run's answer, so it either
    // waits for the slot (`queue: true`) or is refused. Waiting runs
    // (`text === null`) may attach to a session another caller is driving.
    //
    // The registry entry is written before waiting so a queued run is visible in
    // `ping` instead of looking like it never arrived.
    let slot: PromptSlot | null = null;
    const runRecord: ActiveRunRecord = {
      sessionId,
      startedAt,
      prompt: text !== null,
      state: text === null ? "running" : "queued",
    };
    runs.set(runId, runRecord);
    try {
      if (text !== null) {
        // Refuse before waiting: the busy message names the three ways out, and a
        // caller who did not opt into queueing should not wait at all.
        if (!queue && prompting.has(sessionId)) {
          throw new RpcError(
            CODE.busy,
            `session ${sessionId} already has a bridge run waiting for its turn; pass \`queue: true\` to wait for it, use dsh.sessions.wait, or pick a different sessionId`,
            { sessionId },
          );
        }
        slot = await takePromptSlot(sessionId, deadlineAt, signal, runId);
        runRecord.state = "running";
      }
    } catch (error) {
      runs.delete(runId);
      throw error;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let iterator: AsyncIterator<SessionControllerFollowFrame> | null = null;
    let forwardAbort: (() => void) | null = null;
    let timedOut = false;
    // Declared out here so `finally` can always let go of the pending store's
    // waiter, even when the run throws before the consume loop starts.
    let watcher: { promise: Promise<PendingApprovalPacket>; cancel(): void } | null = null;

    // The deadline has to end the run by itself. Aborting is cooperative: it only
    // takes effect when the Host's iterator hands control back, and a stream that
    // has simply stopped producing frames (a turn waiting on a long background job
    // is exactly that) never does. One `wait` in the field sat for 13 minutes on a
    // five-minute budget this way: the timer fired, the abort was recorded, and the
    // caller was still blocked inside `next()`.
    const DEADLINE = Symbol("dsh-rpc deadline");
    let fireDeadline: (() => void) | null = null;
    const deadlineReached = new Promise<never>((_resolve, reject) => {
      fireDeadline = () => reject(DEADLINE);
    });
    // Without a handler a rejected promise is a process-level error, and this one
    // is never awaited when the run finishes first.
    deadlineReached.catch(() => {});

    const abortWithTimeout = () => {
      timedOut = true;
      ac.abort(Object.assign(new Error("dsh-rpc: timed out"), { name: "TimeoutError" }));
      fireDeadline?.();
    };

    // Only turn-scoped events are retained: a long session would otherwise grow
    // the buffer without bound, and everything else is irrelevant to the result.
    const kept: Array<Record<string, unknown>> = [];
    // The cursor is the highest event sequence this run has seen. It is tracked
    // here rather than derived from `kept` because `kept` is capped and `since`
    // must stay monotonic even when old events are dropped.
    let cursor = -1;
    const keep = (event: unknown): void => {
      if (!event || typeof event !== "object") return;
      const rec = event as Record<string, unknown>;
      const seq = num(rec.seq);
      if (seq !== undefined) cursor = Math.max(cursor, seq);
      kept.push(rec);
      if (kept.length > 4000) kept.splice(0, kept.length - 4000);
    };

    // Everything `finalize` sees: the whole turn unless the caller asked for a
    // delta. Status, turn and tools keep describing the turn; only the text is
    // narrowed to what happened after `since` — which is why `finalize` also
    // receives the unfiltered `kept` (see `allEvents`): a delta must not hide a
    // tool call it did not include, or the caller reads `tools: []` next to a
    // text that says "I ran the tests".
    const resultEvents = () =>
      sinceCursor === null ? kept : kept.filter((event) => (num(event.seq) ?? -1) > sinceCursor);
    const wholeEvents = () => (sinceCursor === null ? null : kept);

    // Every read of the event stream goes through here, so the answer is written
    // when *our* budget expires rather than when the Host feels like returning.
    const nextFrame = async (): Promise<IteratorResult<SessionControllerFollowFrame>> => {
      const pending = iterator!.next();
      // The loser of the race stays pending; its late rejection must not escape.
      pending.catch(() => {});
      return Promise.race([pending, deadlineReached]);
    };

    try {
      // A caller that disconnects mid-stream should stop the wait, not leave a
      // dangling iterator holding the session's event pump open. This lives
      // inside the try on purpose: anything that can throw after the registries
      // above are written must still reach the cleanup in `finally`, otherwise a
      // session stays permanently booked as busy.
      if (signal) {
        if (signal.aborted) ac.abort(signal.reason);
        else {
          // Held in a variable so the cleanup below can let go of the caller's
          // signal. Without that, a caller-owned AbortSignal keeps this run's
          // controller reachable — and a later abort reaches a run that is over.
          forwardAbort = () => ac.abort(signal.reason);
          signal.addEventListener("abort", forwardAbort, { once: true });
        }
      }

      timer = setTimeout(abortWithTimeout, deadlineMs);
      // Unref on purpose: a pending bridge call must never be the reason the Host
      // process stays alive. Consequence for tests — anything that awaits this
      // deadline while nothing else holds the loop must keep its own timer alive,
      // otherwise the process exits before the deadline fires.
      if (typeof timer.unref === "function") timer.unref();

      const followRequest = {
        address: { kind: "session" as const, sessionId },
        maxMessages: Math.min(MAX_WAIT_RECORDS, Math.max(1, maxRecords)),
      };
      iterator = controller().follow(followRequest, ac.signal)[Symbol.asyncIterator]();

      // 1. Baseline snapshot.
      let baselineTurn = 0;
      let baselineRunning = false;
      const first = await nextFrame();
      if (!first.done && first.value?.type === "snapshot") {
        const snapshot = first.value;
        const summary = summarizeRecords(snapshot.records);
        baselineTurn = summary.turn;
        baselineRunning = summary.running;
        if (typeof snapshot.cursor === "number") cursor = Math.max(cursor, snapshot.cursor);
        for (const event of summary.events) keep(event);
        onEvent?.({ type: "snapshot", cursor, turn: baselineTurn, running: baselineRunning, records: summary.events });
      } else if (!first.done && first.value?.type === "event") {
        const event = first.value.event;
        keep(event);
        if (event && event.type === "turn/start") {
          baselineTurn = num((event.data as { turn?: unknown } | undefined)?.turn) ?? 0;
          baselineRunning = true;
        } else if (event && event.type === "turn/end") {
          baselineTurn = num((event.data as { turn?: unknown } | undefined)?.turn) ?? 0;
          baselineRunning = false;
        }
        onEvent?.({ type: "event", event });
      }

      // 1.5 `turn` (the default mode): only into an idle session.
      //
      // Judged here, after the baseline, because "is this session running?" is the
      // Host's answer. The bridge's own slot bookkeeping (`prompting`) only sees
      // prompts this process admitted — and the case that created four sessions in
      // the field was exactly a session kept running by a previous, timed-out ask.
      // Refusing here is what turns "silently appended a follow-up message" into a
      // message the caller can act on.
      //
      // `prompting` is deliberately not consulted: this run already holds the slot
      // by now, so it would always match. A second bridge run is refused earlier,
      // before the slot is taken.
      // A timed-out bridge run releases its slot while its Host turn can keep
      // running. Deferred options still need an idle Host before any setter,
      // even when this request waited in the bridge's queue.
      if (
        text !== null && baselineRunning &&
        ((mode === "turn" && !queue) || typeof beforePrompt === "function")
      ) {
        throw new RpcError(
          CODE.busy,
          `session ${sessionId} is already running turn ${baselineTurn}; ` +
            'pass mode:"steer" to inject into the running turn, mode:"queue" to wait for it, ' +
            "or dsh_wait({ session_id }) to collect it",
          { sessionId, turn: baselineTurn, next: { tool: "dsh_wait", args: { session_id: sessionId } } },
        );
      }

      // 2. Admit the prompt (or pick the turn already in flight).
      let targetTurn: number | null = null;
      let requestId: string | null = null;
      if (text !== null) {
        if (typeof beforePrompt === "function") await beforePrompt();
        requestId = `rpc-${randomUUID()}`;
        const promptRequest = controller().prompt(
          {
            requestId,
            sessionId,
            mode: hostMode,
            content: [{ type: "text", text }],
          },
          ac.signal,
        );
        promptRequest.catch(() => {});
        await Promise.race([promptRequest, deadlineReached]);
        targetTurn = hostMode === "steer" && baselineRunning ? baselineTurn : baselineTurn + 1;
        if (targetTurn < 1) targetTurn = 1;
      } else if (!baselineRunning) {
        // Nothing to wait for: report the last completed turn straight away. The
        // status still comes from that turn's own end reason, so an aborted or
        // failed last turn is not misreported as a clean completion.
        const lastEnd = findTurnEnd(kept, baselineTurn);
        return finalize({
          sessionId,
          startedAt,
          turn: baselineTurn > 0 ? baselineTurn : null,
          // `since` narrows the events the caller sees even when there was
          // nothing to wait for: `dsh_wait({ since })` on an idle session is how
          // a caller polls for progress without replaying the whole turn.
          events: resultEvents(),
          allEvents: wholeEvents(),
          sliceMs: deadlineMs,
          requestedMs: requestedDeadlineMs,
          endEvent: lastEnd,
          status: lastEnd
            ? statusFromReason(reasonForEnd(lastEnd)) ?? "unknown"
            : baselineTurn > 0
              ? "completed"
              : "idle",
          timedOut: false,
          requestId: null,
          created: false,
          cursor,
          since: sinceCursor,
        });
      } else {
        targetTurn = baselineTurn;
      }

      // 3. Consume until the target turn ends. The baseline prediction above is
      // only a guess: the event stream is authoritative. Our own prompt's
      // `user/message` carries the requestId just sent, and the Host appends it
      // inside the turn that actually consumed it, which pins the target even when
      // another request (the GUI, another agent) queued ahead of us.
      let endEvent: Record<string, unknown> | null = null;
      // A steered prompt joins the turn already in flight, so that turn is the
      // most recent start we know about even if no new `turn/start` follows.
      let lastStartTurn: number | null = baselineRunning ? baselineTurn : null;
      let attributed = false;

      // A turn blocked on an approval cannot be waited out from the caller's side:
      // the caller is inside the very tool call that is holding the turn, so it
      // cannot call `approvals.pending` until this call returns. Racing the stream
      // against the pending store is what lets the turn hand back "blocked on an
      // approval" while the approval is still open; without it the gate's deadline
      // always expires first and `delegate` can never actually delegate.
      let approvalReached: Promise<PendingApprovalPacket> | null = null;
      let pendingApproval: PendingApprovalPacket | null = null;
      if (typeof approvals?.watch === "function" && config.approvals?.mode === "delegate") {
        watcher = approvals.watch(sessionId);
        approvalReached = watcher.promise;
      }

      type RaceOutcome =
        | { value: IteratorResult<SessionControllerFollowFrame>; approval?: undefined }
        | { approval: PendingApprovalPacket; value?: undefined };

      for (;;) {
        const raced: RaceOutcome = approvalReached
          ? await Promise.race([
              nextFrame().then((value): RaceOutcome => ({ value })),
              approvalReached.then((packet): RaceOutcome => ({ approval: packet })),
            ])
          : { value: await nextFrame() };
        if (raced.approval) {
          pendingApproval = raced.approval;
          break;
        }
        const next = raced.value!;
        if (next.done) break;
        const frame = next.value;
        if (!frame) continue;

        if (frame.type === "assistant-stream") {
          onEvent?.({ type: "assistant-stream", frame: frame.frame });
          continue;
        }
        if (frame.type !== "event") continue;

        const event = frame.event;
        if (!event) continue;
        const eventData = event.data as Record<string, unknown> | undefined;
        if (event.type === "turn/start") {
          const turn = num(eventData?.turn);
          if (turn !== undefined) {
            lastStartTurn = turn;
            // Before attribution, a single-step drift means the prompt was admitted
            // one turn later than predicted. A bigger jump would risk reporting
            // someone else's turn as this call's answer, so it is left to the
            // deadline instead of being adopted silently.
            if (
              !attributed &&
              targetTurn !== null &&
              turn === targetTurn + 1 &&
              !hasAnswerFor(kept, targetTurn)
            ) {
              targetTurn = turn;
            }
          }
        } else if (event.type === "user/message" && !attributed && requestId !== null) {
          const source = eventData?.source as { rpcId?: unknown } | undefined;
          if (source?.rpcId === requestId) {
            const matchedTurn: number | null = lastStartTurn ?? targetTurn;
            if (matchedTurn !== undefined && matchedTurn !== null) targetTurn = matchedTurn;
            attributed = true;
          }
        }
        keep(event);
        onEvent?.({ type: "event", event });

        if (event.type === "turn/end") {
          const turn = num(eventData?.turn);
          if (turn !== undefined && targetTurn !== null && turn < targetTurn) continue;
          // A prompting run must not accept a turn it never saw its own prompt
          // inside: that turn belongs to whoever typed first (the GUI, another
          // agent). Attribution is the gate, so a turn that ends before our
          // `user/message` shows up is somebody else's.
          if (requestId !== null && !attributed) continue;
          endEvent = event;
          break;
        }
      }

      // An aborted follow stream may simply end instead of throwing, so the
      // deadline is authoritative here rather than the iterator's exit reason.
      return finalize({
        sessionId,
        startedAt,
        turn: targetTurn ?? baselineTurn,
        events: resultEvents(),
        allEvents: wholeEvents(),
        sliceMs: deadlineMs,
        requestedMs: requestedDeadlineMs,
        endEvent,
        // If the turn's own end frame made it out, the deadline did not take the
        // answer away from us: reporting "timeout" here would tell the caller to
        // keep waiting for something it already has. A turn held on an approval is
        // neither: it is alive and waiting for the caller.
        status: endEvent ? null : pendingApproval ? "waiting-approval" : timedOut ? "timeout" : null,
        timedOut: endEvent ? false : timedOut,
        requestId,
        created: false,
        cursor,
        since: sinceCursor,
        pendingApproval,
      });
    } catch (error) {
      if (timedOut) {
        return finalize({
          sessionId,
          startedAt,
          turn: maxTurn(kept) || null,
          events: resultEvents(),
          allEvents: wholeEvents(),
          sliceMs: deadlineMs,
          requestedMs: requestedDeadlineMs,
          endEvent: null,
          status: "timeout",
          timedOut: true,
          requestId: null,
          created: false,
          cursor,
          since: sinceCursor,
        });
      }
      throw error;
    } finally {
      watcher?.cancel();
      if (timer) clearTimeout(timer);
      if (forwardAbort) {
        try {
          signal?.removeEventListener?.("abort", forwardAbort);
        } catch {
          // A foreign signal-like object that cannot unsubscribe is not a reason
          // to fail a finished run; the once-listener still cannot fire twice.
        }
      }
      // Registered per run, not per session: two waits may legitimately attach to
      // one session, and a session-keyed entry would let them overwrite each other
      // (undercounting `activeRuns` and letting the concurrency cap drift).
      runs.delete(runId);
      if (prompting.get(sessionId)?.runId === runId) prompting.delete(sessionId);
      // Wake whoever is queued behind this run — including a run that is failing,
      // since the slot is free either way.
      slot?.finish();
      if (iterator && typeof iterator.return === "function") {
        // Bounded on purpose. Awaiting `return()` unbounded put the answer back at
        // the mercy of the very Host that stopped responding: a stream parked in a
        // long `next()` never resolves this, so the run finished its work and then
        // hung in its own cleanup. One `wait` in the field sat 13 minutes that way.
        const closed = Promise.resolve()
          .then(() => iterator!.return!())
          .catch(() => {
            // The stream may already be torn down by the abort; disposing twice is
            // not an error worth surfacing to the caller.
          });
        let handle: ReturnType<typeof setTimeout> | null = null;
        const bound = new Promise<void>((resolve) => {
          const boundTimer = setTimeout(resolve, ITERATOR_RETURN_MS);
          handle = boundTimer;
          if (typeof boundTimer.unref === "function") boundTimer.unref();
        });
        try {
          await Promise.race([closed, bound]);
        } finally {
          if (handle) clearTimeout(handle);
        }
      }
    }
  }

  /**
   * Submit a prompt without waiting for the turn: the caller gets a handle and
   * collects the answer later with `wait`/`history`. This is the shape an outer
   * agent needs when its own tool-call budget is shorter than the work.
   *
   * `guard` is what separates the two callers: `ask({wait:false})` refuses a
   * session already running a turn (the caller asked for *this* prompt's answer,
   * and silently joining another turn would hand back somebody else's work),
   * while `dsh.sessions.prompt` has always been a pure fire-and-forget and keeps
   * that behaviour. One body, one place to change, one explicit difference.
   *
   * Deliberately does NOT take the `prompting` slot: that map tracks *bridge
   * runs waiting for a turn*, and there is nothing to wait for here. The
   * consequence is a millisecond-wide window in which two calls on one session
   * can both pass the busy check; `list()` is the cheapest honest check
   * available and 0.5.0's sticky-session registry will close it.
   */
  async function submitPrompt(
    sessionId: string,
    text: string,
    mode: AskMode,
    extra: Record<string, unknown>,
    { guard = true }: { guard?: boolean } = {},
  ): Promise<SessionsAskResult> {
    const { items = [] } = (await controller().list({}, IDLE_SIGNAL)) ?? {};
    const listed = items.find((item) => item.sessionId === sessionId);
    if (guard && listed?.running && mode !== "steer") {
      throw new RpcError(
        CODE.busy,
        `session ${sessionId} is already running a turn; pass wait:true to follow it, mode:"steer" to join it, or a different sessionId`,
        { sessionId, next: { tool: "dsh_wait", args: { session_id: sessionId } } },
      );
    }
    const requestId = `rpc-${randomUUID()}`;
    // Same translation as `drive()`: the Host only knows steer/queue.
    const hostMode = mode === "steer" ? "steer" : "queue";
    await controller().prompt({ requestId, sessionId, mode: hostMode, content: [{ type: "text", text }] }, IDLE_SIGNAL);
    // `list()` items carry neither a turn number nor a cursor, and no event has
    // been seen yet: report `turn: null` rather than a guess and omit `cursor`
    // instead of inventing one. The first `wait` learns both from the stream,
    // and a caller that only wants the new turn needs no `since` for that.
    return {
      sessionId,
      requestId,
      mode,
      status: "running",
      turn: null,
      text: "",
      accepted: true,
      created: false,
      ...extra,
    };
  }

  const startOnly = (sessionId: string, text: string, mode: AskMode, extra: Record<string, unknown>) =>
    submitPrompt(sessionId, text, mode, extra);

  function finalize({
    sessionId,
    startedAt,
    turn,
    events,
    allEvents = null,
    endEvent,
    status,
    timedOut,
    requestId,
    created,
    cursor,
    since = null,
    sliceMs = null,
    requestedMs = null,
    pendingApproval = null,
  }: {
    sessionId: string;
    startedAt: number;
    turn: number | null;
    events: Array<Record<string, unknown>>;
    allEvents?: Array<Record<string, unknown>> | null;
    endEvent: Record<string, unknown> | null;
    status: string | null;
    timedOut: boolean;
    requestId: string | null;
    created: boolean;
    cursor: number;
    since?: number | null;
    sliceMs?: number | null;
    requestedMs?: number | null;
    pendingApproval?: PendingApprovalPacket | null;
  }): SessionsAskResult {
    const effectiveTurn = turn ?? maxTurn(allEvents ?? events);
    const collected = collectTurn(events, effectiveTurn);
    // A delta answer still has to describe the whole turn: `tools`/`usage`/
    // `sandbox` come from the unfiltered events, only the prose is narrowed.
    const whole = allEvents ? collectTurn(allEvents, effectiveTurn) : collected;
    // A wait that expires has no `turn/end` to quote, and leaving `reason` null
    // was half the reason a live turn looked like a silent failure: the caller
    // got "timeout" with nothing else. The turn genuinely has not ended, so say
    // exactly that. `status` is already passed explicitly on those paths, so this
    // reason never feeds `statusFromReason()`.
    // A `turn/end` that carries no reason used to fall through to `"completed"`:
    // the union says the field is required, but a union is a type, not a runtime
    // guard. An ending nobody recorded is unverified, not successful.
    const reason =
      reasonForEnd(endEvent) ??
      (timedOut
        ? { kind: "timeout", message: "the turn had not finished when the wait budget expired; it keeps running" }
        : null);
    const resolvedStatus = status ?? statusFromReason(reason) ?? (endEvent ? "completed" : "unknown");
    const sandbox = sandboxDenial(whole);
    const result: SessionsAskResult = {
      sessionId,
      turn: effectiveTurn,
      status: resolvedStatus,
      reason: reason ? safeJson(reason) : null,
      // The stream can close before `turn/end` arrives (Host teardown, a dropped
      // subscription). The text collected so far is then a prefix, not an answer —
      // say so instead of letting a truncated reply look complete.
      partial: endEvent === null && !timedOut && resolvedStatus === "unknown",
      text: collected.text,
      reasoning: collected.reasoning || undefined,
      tools: whole.tools,
      usage: whole.usage ?? undefined,
      durationMs: Date.now() - startedAt,
      timedOut,
      requestId,
      created,
      cursor: cursor ?? -1,
      turnStartedAt: whole.startedAt ?? null,
      // A slice is not the caller's budget. Report both so a caller can tell
      // "this is all you get per request" from "your budget is gone".
      ...(sliceMs !== null && requestedMs !== null && sliceMs < requestedMs ? { sliceMs, requestedMs } : {}),
    };
    // Echo the cursor the caller asked to start from, so a delta result is
    // self-describing: `since` < the events below <= `cursor`.
    if (since !== null) result.since = since;
    if (sandbox.denied) {
      // A sandbox refusal is not an error: the turn ran, the agent answered, and
      // one specific action was blocked. The bridge reports the fact and points
      // at the decision that has to be made — it does not make it. Handing the
      // caller a ready-made "retry with full access" call would let the blocked
      // agent's own wording steer that decision.
      result.sandbox = sandbox;
      result.next = {
        tool: "dsh_ask",
        reason:
          "The turn was blocked by the DSH sandbox. Whether this session may run with a wider preset " +
          "is the caller's decision: re-ask with `permission` only after deciding that, in this same session.",
        args: { session_id: sessionId },
      };
    }
    if (pendingApproval) {
      // The turn is not over: it is blocked inside a tool call waiting for the
      // caller to decide. Calling that a timeout would be a lie, and a bare status
      // would leave the caller without the id it needs to answer.
      result.pendingApproval = safeJson(pendingApproval);
      result.next = {
        tool: "dsh_approvals_resolve",
        reason:
          "The turn is blocked on a sandbox escalation. Answer it with dsh_approvals_resolve " +
          "(dsh_approvals_pending re-reads the packet), then collect the turn with dsh_wait.",
        args: { approval_id: pendingApproval.approvalId, decision: "allow-once" },
      };
    }
    return result;
  }

  // ---------------------------------------------------------------- methods --

  const discover: CreateMethodsResult["discover"] = async () => {
    return {
      plugin: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      // The MCP layer derives its default budget and its hints from this, so
      // the value lives in one place instead of being copied into the client.
      config: describeConfig(config),
      transport: {
        rpc: `${config.path} (POST, JSON-RPC 2.0)`,
        stream: `${config.path}/stream (POST, application/x-ndjson)`,
        health: `${config.path}/health (GET, unauthenticated)`,
        auth: "Authorization: Bearer <token> (or X-DSH-RPC-Token)",
      },
      methods: tasksEnabled()
        ? METHOD_CATALOG
        : METHOD_CATALOG.filter((entry) => !TASK_FAMILY_METHODS.has(entry.name)),
    };
  };

  const tasksEnabled = () => config.tasksEnabled === true;

  const ping: CreateMethodsResult["ping"] = async () => {
    return {
      ok: true,
      plugin: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      origin: originOf(webServer),
      pid: process.pid,
      node: process.version,
      uptimeMs: Math.round(process.uptime() * 1000),
      config: describeConfig(config),
      state: {
        tokenSource: state?.tokenSource ?? "unknown",
        tokenPath: state?.tokenPath ?? null,
        endpointPath: state?.endpointPath ?? null,
      },
      taskCentre: {
        enabled: taskCentre?.enabled ?? config?.tasksEnabled === true,
        mode: taskCentre?.mode ?? "unknown",
        ready: taskCentre?.ready ?? false,
        dbPath: taskCentre?.dbPath ?? config?.tasksDbPath ?? null,
        store: taskStore ? "injected" : resolvedTaskEngine ? "engine" : "lazy",
        seedError: taskCentre?.seedError ?? null,
        startError: taskCentre?.startError ?? null,
        // The pass that starts and pumps tasks is only useful if its outcome is
        // readable: "it ran and did nothing" must not look like "it never ran".
        autopilot: taskCentre?.autopilot ?? null,
        autopilotStats: taskCentre?.autopilotStats ?? null,
      },
      activeRuns: [...runs.entries()].map(([runId, run]) => ({
        sessionId: run.sessionId,
        runId,
        prompt: run.prompt,
        state: run.state,
        ageMs: Date.now() - run.startedAt,
      })),
    };
  };

  const models: CreateMethodsResult["models"] = async () => {
    const catalog = await controller().modelCatalog?.();
    return {
      default: catalog?.default ?? null,
      routableProviders: catalog?.routableProviders ?? [],
      groups: catalog?.groups ?? [],
      failures: catalog?.failures ?? [],
    };
  };

  const listWorkspaces: CreateMethodsResult["listWorkspaces"] = async () => {
    const registry = ctx.get?.("workspaceRegistry") as
      | {
          list(): Array<{
            id: string;
            title: string;
            path: string;
            status(): Promise<string>;
            sessionIds?: unknown[];
            createdAt?: unknown;
            updatedAt?: unknown;
          }>;
        }
      | undefined;
    if (!registry) {
      throw new RpcError(
        CODE.server,
        "this Harness deployment exposes no workspaceRegistry service, so workspaces cannot be listed",
      );
    }
    const items: WorkspaceProjection[] = [];
    for (const workspace of registry.list()) {
      let status = "unknown";
      try {
        status = await workspace.status();
      } catch {
        status = "unknown";
      }
      items.push({
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
        status,
        sessions: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
        createdAt: workspace.createdAt ?? null,
        updatedAt: workspace.updatedAt ?? null,
      });
    }
    return { total: items.length, items };
  };

  const createWorkspace: CreateMethodsResult["createWorkspace"] = async (params: WorkspacesCreateParams = {}) => {
    const path = requireText(params.path, "path");
    const title = optionalString(params.title, "title");
    const registry = ctx.get?.("workspaceRegistry") as
      | {
          create(path: string, title?: string): Promise<{ id: string; title: string; path: string }>;
        }
      | undefined;
    if (!registry) {
      throw new RpcError(
        CODE.server,
        "this Harness deployment exposes no workspaceRegistry service, so workspaces cannot be created",
      );
    }
    const workspace = await registry.create(path, title || undefined);
    return { id: workspace.id, title: workspace.title, path: workspace.path };
  };

  const permissionCatalog: CreateMethodsResult["permissionCatalog"] = async () => {
    const service = permissionPresets();
    const catalog = (await service.catalog?.()) ?? {};
    return {
      defaultPreset: catalog.defaultPreset ?? null,
      options: (Array.isArray(catalog.options) ? catalog.options : []).map((option) => ({
        value: option.value,
        name: option.name,
        description: option.description ?? null,
        // `description` comes from the deployment and is frequently null; the
        // cost sentence is the bridge's own, so a caller can tell the presets
        // apart even when the deployment declared none.
        cost: PRESET_COST[option.value] ?? null,
      })),
      defaultOptions: (Array.isArray(catalog.defaultOptions) ? catalog.defaultOptions : []).map(
        (option) => option.value,
      ),
    };
  };

  const configure: CreateMethodsResult["configure"] = async (params: SessionsConfigureParams = {}) => {
    const sessionId = requireSessionId(params.sessionId);
    const applied = await applySessionOptions(sessionId, params);
    if (Object.keys(applied).length === 0) {
      throw badRequest("nothing to configure: pass `model`, `reasoningEffort` or `permissionPreset`");
    }
    return { sessionId, ...applied };
  };

  const approvalsPending: CreateMethodsResult["approvalsPending"] = async (
    params: ApprovalsPendingParams = {},
    context: RpcDispatchContext = {},
  ) => {
    const store = approvalsStore();
    // `optionalString` answers "" for an absent field; the store treats a
    // string as a filter, so "" would match nothing instead of everything.
    const sessionId = optionalString(params.sessionId, "sessionId") || undefined;
    // `waitMs` is a duration, not a hint: a fractional or out-of-range value is
    // a caller bug, and silently clamping it would make a caller believe it
    // waited longer than it did.
    const requested = params.waitMs;
    let waitMs = 0;
    if (requested !== undefined && requested !== null) {
      if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 0 || requested > 120_000) {
        throw badRequest("`waitMs` must be an integer between 0 and 120000");
      }
      waitMs = requested;
    }
    const { signal } = internalContext(context);
    const answer = await store.waitForAny({ sessionId, waitMs, signal });
    return {
      pending: answer.pending,
      count: answer.pending.length,
      timedOut: answer.timedOut === true,
      mode: config.approvals?.mode ?? "off",
      deadlineMs: config.approvals?.deadlineMs ?? null,
    };
  };

  const approvalsResolve: CreateMethodsResult["approvalsResolve"] = async (params: ApprovalsResolveParams = {}) => {
    const store = approvalsStore();
    const approvalId = optionalString(params.approvalId, "approvalId");
    if (!approvalId) throw badRequest("`approvalId` is required");
    const decision = params.decision;
    if (decision !== "allow-once" && decision !== "reject") {
      throw badRequest('`decision` must be "allow-once" or "reject"');
    }
    const note = optionalString(params.note, "note") || null;
    const outcome = store.resolve(approvalId, decision, note);
    if (!outcome.resolved) {
      throw new RpcError(
        CODE.notFound,
        `no pending approval "${approvalId}": it may have expired, already been answered, or never existed`,
        { approvalId },
      );
    }
    return {
      approvalId,
      sessionId: outcome.sessionId ?? null,
      toolName: outcome.toolName ?? null,
      decision,
      note,
    };
  };

  const listSessions: CreateMethodsResult["listSessions"] = async (params: SessionsListParams = {}) => {
    const limit = optionalLimit(params.limit, { fallback: 50 });
    const cwd = optionalString(params.cwd, "cwd");
    const sort = optionalChoice(params.sort, ["updatedAt", "createdAt"] as const, "updatedAt", "sort");
    const value = await controller().list({}, IDLE_SIGNAL);
    const all = Array.isArray(value?.items) ? value.items : [];
    // `cwd` is a prefix: a caller looking for "the sessions under this project"
    // should not have to enumerate every subdirectory it ever ran in.
    const scoped = cwd ? all.filter((item) => withinPath(item?.cwd, cwd)) : all;
    const sorted = [...scoped].sort((a, b) => timeOfItem(b, sort) - timeOfItem(a, sort));
    return {
      total: sorted.length,
      sort,
      cwd: cwd ?? null,
      items: sorted.slice(0, limit).map((item) => ({
        sessionId: item.sessionId,
        running: Boolean(item.running),
        blank: Boolean(item.blank),
        agentAvailable: item.agentAvailable !== false,
        updatedAt: item.updatedAt ?? null,
        createdAt: item.createdAt ?? null,
        cwd: item.cwd ?? null,
        agentPreset: item.projections?.agentPreset ?? null,
        origin: item.origin ?? null,
        parentSessionId: item.parentSessionId ?? null,
      })),
    };
  };

  const createSessionMethod: CreateMethodsResult["createSession"] = async (params: SessionsCreateParams = {}) => {
    return createSession(params);
  };

  const ask: CreateMethodsResult["ask"] = async (
    params: SessionsAskParams = {},
    context: RpcDispatchContext = {},
  ) => {
    const text = requireText(params.text, "text");
    const mode = optionalChoice(params.mode, ASK_MODES, "turn", "mode");
    const reuse = optionalChoice(params.reuse, REUSE_MODES, "auto", "reuse");
    const project = optionalString(params.project, "project");
    const namespace = optionalString(params.namespace, "namespace");
    let sessionId = optionalString(params.sessionId, "sessionId");
    let created = false;
    let reused = false;
    let rotated = false;
    let previousSessionId: string | null = null;
    let resolvedCwd: string | null = null;
    let applied: { selected?: SelectedModel; permissionPreset?: string } = {};
    let stickyKey: string | null = null;
    let stickyReservation: StickyReservation | null = null;
    let stickyQueue = false;
    let deferredStickyOptions = false;
    let stickyOptionPlan: PreparedStickyOptions | null = null;
    const trackStickyRun = params.wait !== false && mode === "turn";
    if (!sessionId) {
      const { workspaceId, cwd } = createTarget(params);
      // A workspace is a better scope than its directory when both exist: two
      // checkouts of one workspace should land in one session.
      stickyKey = reuse === "never" ? null : registryKey({ namespace, project, cwd: workspaceId ? `workspace:${workspaceId}` : cwd });
      if (stickyKey) {
        const currentStickyKey = stickyKey;
        const acquire = async (): Promise<AcquiredStickyResult> => {
          const entry = await lookupEntry(currentStickyKey);
          let reservation = stickySessions.get(currentStickyKey);
          // An in-flight reservation is reusable even after its first prompt
          // makes the Host session nonblank. Idle reservations remain a fallback
          // only while the Host still reports the session blank.
          const hostItems = entry || reservation
            ? ((await controller().list({}, IDLE_SIGNAL))?.items ?? [])
            : [];
          const listed = entry ? hostItems.find((item) => item?.sessionId === entry.sessionId) : null;
          const reservedItem = reservation
            ? hostItems.find((item) => item?.sessionId === reservation?.sessionId)
            : null;
          const reservedActive =
            trackStickyRun && (reservation?.inFlight ?? 0) > 0 && reservedItem && !reservedItem.blank;
          if (reservation && (!reservedItem || (!reservedItem.blank && !reservedActive && reservation.inFlight === 0))) {
            stickySessions.delete(currentStickyKey);
            reservation = undefined;
          }
          const reserved = reservedItem?.blank ? reservation : reservedActive ? reservation : null;
          const usableEntry = reserved ?? (listed && !listed.blank ? entry : null);
          const entryRotated =
            !reservedActive &&
            entry?.sessionId === usableEntry?.sessionId &&
            typeof entry?.asks === "number" &&
            Number.isInteger(entry.asks) &&
            entry.asks >= ROTATE_AFTER_ASKS;
          const reusable = Boolean(usableEntry && !entryRotated);
          if (reusable && usableEntry) {
            const deferredOptions = params.wait !== false;
            const optionPlan = deferredOptions
              ? await prepareStickySessionOptions(params)
              : null;
            const selected = deferredOptions ? {} : await applySessionOptions(usableEntry.sessionId, params);
            const active = reserved ?? { sessionId: usableEntry.sessionId, cwd: listed?.cwd ?? usableEntry.cwd ?? null, inFlight: 0 };
            const queue = active.inFlight > 0;
            if (trackStickyRun) active.inFlight += 1;
            stickySessions.set(currentStickyKey, active);
            return {
              sessionId: usableEntry.sessionId,
              cwd: listed?.cwd ?? usableEntry.cwd ?? null,
              created: false,
              applied: selected,
              stickyReservation: active,
              stickyQueue: queue,
              deferredOptions,
              optionPlan,
            };
          }
          const rotatedEntry = listed && !listed.blank && typeof entry?.asks === "number" && Number.isInteger(entry.asks) && entry.asks >= ROTATE_AFTER_ASKS
            ? entry
            : null;
          const session = await createSession(params);
          const active: StickyReservation = { sessionId: session.sessionId, cwd: session.cwd, inFlight: trackStickyRun ? 1 : 0 };
          stickySessions.set(currentStickyKey, active);
          return {
            sessionId: session.sessionId,
            cwd: session.cwd,
            created: true,
            selected: session.selected,
            permissionPreset: session.permissionPreset,
            rotatedEntry,
            stickyReservation: active,
            stickyQueue: false,
          };
        };
        const acquired = await withStickyLock(currentStickyKey, acquire);
        sessionId = acquired.sessionId;
        resolvedCwd = acquired.cwd;
        created = acquired.created;
        reused = !acquired.created;
        stickyReservation = acquired.stickyReservation ?? null;
        stickyQueue = acquired.stickyQueue === true;
        if (acquired.created) {
          applied = {
            ...(acquired.selected ? { selected: acquired.selected } : {}),
            ...(acquired.permissionPreset ? { permissionPreset: acquired.permissionPreset } : {}),
          };
          if (acquired.rotatedEntry) {
            rotated = true;
            previousSessionId = acquired.rotatedEntry.sessionId;
          }
        } else {
          applied = acquired.applied ?? {};
          deferredStickyOptions = acquired.deferredOptions === true;
          stickyOptionPlan = acquired.optionPlan ?? null;
        }
      } else {
        const session = await createSession(params);
        sessionId = session.sessionId;
        resolvedCwd = session.cwd;
        created = true;
        applied = {
          ...(session.selected ? { selected: session.selected } : {}),
          ...(session.permissionPreset ? { permissionPreset: session.permissionPreset } : {}),
        };
      }
    } else {
      // Where a session lives, and which preset it started with, are fixed at
      // creation; naming either now would be a request this method cannot honour,
      // so it is refused instead of ignored.
      if (optionalString(params.workspaceId, "workspaceId") || optionalString(params.cwd, "cwd")) {
        throw badRequest(
          "`workspaceId` and `cwd` only apply when the session is created; drop `sessionId` to start a new one in that location",
        );
      }
      if (optionalString(params.agentPreset, "agentPreset")) {
        throw badRequest(
          "`agentPreset` only applies when the session is created; drop `sessionId` to start a new one with that preset",
        );
      }
      applied = await applySessionOptions(sessionId, params);
      // An explicit id becomes a sticky decision only when the caller also names
      // the scope (`project`): the directory of an existing session may be
      // unrelated to what the caller is working on, and guessing it would enroll
      // the session into the wrong bucket.
      if (reuse !== "never" && project) {
        stickyKey = registryKey({ namespace, project, cwd: null });
      }
    }
    // Ownership never comes from the sticky registry. The registry is a
    // shortcut for "which session did this project use", and `ask` writes it
    // whenever a caller names a `project` — so treating it as proof of ownership
    // let a caller enrol a session a human is driving and then answer that
    // session's approvals. Ownership is the in-memory set populated at creation;
    // a session from an earlier process is simply not ours, and for it the gate
    // stays silent, which leaves the Host's own answerer in charge.
    if (config.approvals?.mode !== "off" && sessionId && !created && !isOwnedSession(sessionId)) {
      log.info?.(
        `[dsh-rpc] ${sessionId} was not created by this process; its approvals stay with the Host's own answerer`,
      );
    }
    const remember = async () => {
      if (!stickyKey) return;
      // Only our own sessions are worth remembering: a registry entry for
      // somebody else's session would be a shortcut this bridge can never use.
      if (!isOwnedSession(sessionId)) return;
      await rememberEntry(stickyKey, {
        sessionId,
        project: project ?? null,
        cwd: resolvedCwd,
        previousSessionId: rotated ? previousSessionId : null,
      }).catch((error: unknown) => {
        // Losing the shortcut must never fail the call: the session is already
        // created and the answer is already on its way.
        const msg =
          error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message
            : String(error);
        log.warn?.(`[dsh-rpc] could not register sticky session for ${stickyKey}: ${msg}`);
      });
    };
    const { onEvent, signal } = internalContext(context);
    const extra: Record<string, unknown> = {
      created,
      cwd: resolvedCwd,
      ...(reused ? { reused: true } : {}),
      ...(rotated ? { rotated: true, previousSessionId } : {}),
      ...applied,
    };
    // Non-blocking shape: hand back a handle in milliseconds. The RPC default
    // stays `wait: true` — a protocol method keeps its shape across minor
    // versions; the *MCP tool* is where 0.5.0 flips the default to the handle,
    // because that is the surface an outer agent's tool budget applies to.
    if (params.wait === false) {
      // `queue` means "wait for the session to free its turn"; with `wait:false`
      // nothing waits, so honouring it would be a lie and ignoring it would be
      // a silent no-op. Refuse, and let the caller pick one of the two.
      if (params.queue === true || mode === "queue") {
        throw badRequest("`queue` has no meaning with `wait: false`: nothing is waited for; use wait:true, or mode:\"steer\"");
      }
      const handle = await startOnly(sessionId, text, mode, extra);
      await remember();
      log.info?.(`[dsh-rpc] ask ${sessionId} -> accepted without waiting (${handle.requestId})`);
      return handle;
    }
    const run = () => {
      let deferredApplied: { selected?: SelectedModel; permissionPreset?: string } | null = null;
      return drive(sessionId, {
        text,
        mode,
        queue: params.queue === true || (mode === "turn" && stickyQueue),
        timeoutMs: params.timeoutMs,
        onEvent,
        signal,
        ...(deferredStickyOptions && stickyOptionPlan
          ? {
              beforePrompt: async () => {
                deferredApplied = await applyPreparedStickyOptions(sessionId, stickyOptionPlan!);
              },
            }
          : {}),
      }).then((value) => ({ value, deferredApplied }));
    };
    const driven = await run()
      .then(async ({ value, deferredApplied }) => {
        await remember();
        return { value, deferredApplied };
      })
      .finally(() => (trackStickyRun ? releaseStickySession(stickyKey, stickyReservation) : undefined));
    const result = driven.value;
    const appliedExtra = deferredStickyOptions ? { ...extra, ...driven.deferredApplied } : extra;
    log.info?.(`[dsh-rpc] ask ${sessionId} -> ${result.status} in ${result.durationMs}ms`);
    return { ...result, ...appliedExtra };
  };

  const prompt: CreateMethodsResult["prompt"] = async (params: SessionsPromptParams = {}) => {
    const sessionId = requireSessionId(params.sessionId);
    const text = requireText(params.text, "text");
    const mode = optionalChoice(params.mode, ASK_MODES, "queue", "mode");
    // Where a session lives and which preset it started with are fixed at
    // creation — same rule as `ask`: refuse instead of ignoring.
    if (optionalString(params.workspaceId, "workspaceId") || optionalString(params.cwd, "cwd")) {
      throw badRequest(
        "`workspaceId` and `cwd` only apply when the session is created; drop `sessionId` to start a new one in that location",
      );
    }
    if (optionalString(params.agentPreset, "agentPreset")) {
      throw badRequest(
        "`agentPreset` only applies when the session is created; drop `sessionId` to start a new one with that preset",
      );
    }
    // `model` / `reasoningEffort` / `permissionPreset` are session settings, so
    // they are applied here exactly as `ask` applies them. The CLI advertises
    // `prompt --model`; a flag that silently does nothing is how a dispatch gets
    // sent to the wrong model without anyone noticing.
    const applied = await applySessionOptions(sessionId, params);
    // `guard: false` keeps the documented fire-and-forget behaviour: `prompt`
    // has never refused a busy session, and this release is not the place to
    // change that. The code path is shared so the two cannot drift.
    const handle = await submitPrompt(sessionId, text, mode, {}, { guard: false });
    return {
      accepted: true,
      sessionId,
      requestId: handle.requestId as string,
      mode,
      ...(applied.selected ? { selected: applied.selected } : {}),
      ...(applied.permissionPreset ? { permissionPreset: applied.permissionPreset } : {}),
    };
  };

  const wait: CreateMethodsResult["wait"] = async (
    params: SessionsWaitParams = {},
    context: RpcDispatchContext = {},
  ) => {
    const sessionId = requireSessionId(params.sessionId);
    const { onEvent, signal } = internalContext(context);
    // `since` narrows the answer to what happened after the caller's last
    // cursor; the turn, status and tool list still describe the whole turn.
    return drive(sessionId, { text: null, timeoutMs: params.timeoutMs, since: params.since, onEvent, signal });
  };

  const cancel: CreateMethodsResult["cancel"] = async (params: SessionsCancelParams = {}) => {
    const sessionId = requireSessionId(params.sessionId);
    const value = await controller().cancel({ sessionId });
    return { accepted: value?.accepted !== false, sessionId };
  };

  const history: CreateMethodsResult["history"] = async (params: SessionsHistoryParams = {}) => {
    const sessionId = requireSessionId(params.sessionId);
    const limit = optionalLimit(params.limit, { max: MAX_WAIT_RECORDS, fallback: 40 });
    const since = optionalNonNegInt(params.since, "since");
    const kinds = optionalKinds(params.kinds);
    const maxChars = optionalNonNegInt(params.maxChars, "maxChars");
    const budget = Number.isInteger(config?.historyBudgetMs)
      ? (config.historyBudgetMs as number)
      : DEFAULT_HISTORY_BUDGET_MS;
    const snapshot = await readSessionSnapshot(controller(), { sessionId, limit, budgetMs: budget });
    if (snapshot.missing) {
      return { sessionId, cursor: -1, records: [] };
    }
    const summary = summarizeRecords(snapshot.records);
    let events = summary.events;
    if (since !== null) {
      events = events.filter((event) => (num(event.seq) ?? -1) > since);
    }
    if (kinds !== null) {
      events = events.filter((event) => typeof event.type === "string" && kinds.has(event.type));
    }
    const projected = events.map(projectEvent);
    const bounded = maxChars !== null && maxChars > 0 ? applyMaxCharsToRecords(projected, maxChars) : null;
    return {
      sessionId,
      cursor: snapshot.cursor ?? -1,
      turn: summary.turn,
      running: summary.running,
      messageCount: Array.isArray(snapshot.records) ? snapshot.records.length : 0,
      hasMore: Boolean(snapshot.hasMore),
      records: bounded ? bounded.records : projected,
      ...(bounded ? { truncated: bounded.truncated } : {}),
    };
  };

  const capabilities: CreateMethodsResult["capabilities"] = async (params: CapabilitiesParams = {}) => {
    const rawSections = params.sections;
    if (rawSections !== undefined && rawSections !== null && rawSections !== "*") {
      if (!Array.isArray(rawSections)) {
        throw badRequest('`sections` must be an array of section ids or "*"');
      }
      for (const item of rawSections) {
        if (typeof item !== "string" || item.trim().length === 0) {
          throw badRequest("`sections` entries must be non-empty strings");
        }
      }
    }

    const maxCharsKey = params.max_chars !== undefined ? "max_chars" : "maxChars";
    const maxChars = optionalNonNegInt(
      params.max_chars !== undefined ? params.max_chars : params.maxChars,
      maxCharsKey,
    );
    if (maxChars !== null && maxChars > MAX_MAX_CHARS) {
      throw badRequest(`\`${maxCharsKey}\` must be between 0 and ${MAX_MAX_CHARS}`);
    }

    const sessionIdKey = params.session_id !== undefined ? "session_id" : "sessionId";
    const sessionId = optionalString(
      params.session_id !== undefined ? params.session_id : params.sessionId,
      sessionIdKey,
    );

    const normalized = normalizeSections(rawSections);
    const collected =
      normalized.sections.length === 0
        ? []
        : await collectFacts({
            ctx,
            config: config as Record<string, unknown>,
            state: state as Record<string, unknown>,
            sessionId: sessionId || null,
            sections: normalized.sections,
          });
    const formatted = formatCapabilities(collected, {
      maxChars: maxChars === null ? undefined : maxChars,
      missing: normalized.missing,
    });
    return {
      sections: formatted.structured.sections,
      text: formatted.text,
      truncated: formatted.truncated,
      missing: formatted.missing,
    };
  };

  const submitTask: CreateMethodsResult["submitTask"] = async (params: TasksSubmitParams = {}) => {
    return getTaskEngine().submit(params);
  };

  const getTask: CreateMethodsResult["getTask"] = async (params: TasksGetParams = {}) => {
    return getTaskEngine().get(params);
  };

  const listTasks: CreateMethodsResult["listTasks"] = async (params: TasksListParams = {}) => {
    return getTaskEngine().list(params);
  };

  const taskEvents: CreateMethodsResult["taskEvents"] = async (params: TasksEventsParams = {}) => {
    return getTaskEngine().events(params);
  };

  const inputTask: CreateMethodsResult["inputTask"] = async (params: TasksInputParams = {}) => {
    return getTaskEngine().input(params);
  };

  const readArtifactTask: CreateMethodsResult["readArtifactTask"] = async (params: TasksReadArtifactParams = {}) => {
    return getTaskEngine().readArtifact(params);
  };

  const getAgent: CreateMethodsResult["getAgent"] = async (params: AgentsGetParams = {}) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId) {
      throw new RpcError(CODE.invalidParams, "agentId is required", {
        kind: "VALIDATION_FAILED",
        field: "agentId",
      });
    }
    const store = getTaskStore();
    const row = store.read((db) => db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as AgentRow | undefined);
    if (!row) {
      throw new RpcError(CODE.notFound, "agent not found: " + agentId, { kind: "NOT_FOUND", agentId });
    }
    const parse = <T,>(value: unknown, fallback: T): T => {
      if (typeof value !== "string" || !value) return fallback;
      try {
        return JSON.parse(value) as T;
      } catch {
        return fallback;
      }
    };
    // Revisions are keyed by capability+version, not by agent: the published set an
    // instance owns is the one recorded inside its own card, so read that first and
    // only then resolve the rows. Filtering by a non-existent agent_id column would
    // fail on every call.
    const cardJson = parse<Record<string, unknown>>(row.capabilities_json, {});
    const declared = Array.isArray(cardJson?.capabilities) ? cardJson.capabilities : [];
    const declaredKeys = new Set(
      declared.map((entry: Record<string, unknown>) => `${entry?.capabilityId ?? entry?.capability ?? ""}@${entry?.version ?? ""}`),
    );
    const capabilityRevisions = (
      store.read((db) =>
        db
          .prepare(
            "SELECT revision_id, capability, version, side_effect_kind, cancel_policy, limitations_json, created_at FROM capability_revisions ORDER BY capability, version",
          )
          .all(),
      ) as unknown as CapabilityRevisionRow[]
    ).filter((rev) => declaredKeys.size === 0 || declaredKeys.has(`${rev.capability}@${rev.version}`));
    const extRow = row as AgentRow & { project_id?: string | null; registered_at?: string | null };
    return {
      agentId: row.agent_id,
      adapterKind: row.adapter_kind,
      enabled: row.enabled === 1,
      projectId: extRow.project_id ?? null,
      probeStatus: row.probe_status ?? null,
      probeExpiresAt: row.probe_expires_at ?? null,
      registeredAt: extRow.registered_at ?? null,
      updatedAt: row.updated_at ?? null,
      card: parse<unknown>(row.capabilities_json, {}),
      capabilityRevisions: capabilityRevisions.map((rev) => ({
        revisionId: rev.revision_id,
        capability: rev.capability,
        version: rev.version,
        sideEffectKind: rev.side_effect_kind,
        cancelPolicy: rev.cancel_policy,
        limitations: parse<unknown>(rev.limitations_json, []),
        createdAt: rev.created_at,
      })),
    };
  };

  const cancelTask: CreateMethodsResult["cancelTask"] = async (params: TasksCancelParams = {}) => {
    return getTaskEngine().cancel(params);
  };

  const previewTask: CreateMethodsResult["previewTask"] = async (params: TasksPreviewParams = {}) => {
    const store = getTaskStore();
    // No silent default: the caller must name the identity it acts for. Until the
    // identity layer (W3) lands, installs seed a "local-operator" principal.
    const principalId = typeof params.principalId === "string" ? params.principalId.trim() : "";
    if (!principalId) {
      throw validationFailed("`principalId` is required", { field: "principalId" });
    }
    const ttlMs = params.ttlMs ?? config?.tasksPreviewTtlMs ?? 300_000;
    const digestInput = {
      capabilityRevisionId: params.capabilityRevisionId ?? null,
      workspaceId: params.workspaceId ?? null,
      agentId: params.agentId ?? null,
      input: params.input ?? null,
    };
    // A digest the caller supplies is a promise about the request being previewed. Replacing a
    // non-string with a computed one would keep the preview working while dropping that promise —
    // `requestDigest: 123` would bind nothing and look fine (same class as the submit fix; quality
    // review, 0.9.4). Absent or null still means "compute it for me".
    const suppliedDigest = params.requestDigest;
    if (suppliedDigest !== undefined && suppliedDigest !== null && typeof suppliedDigest !== "string") {
      throw validationFailed("`requestDigest` must be a string", { field: "requestDigest" });
    }
    const requestDigest =
      typeof suppliedDigest === "string" && suppliedDigest.trim()
        ? suppliedDigest.trim()
        : createHash("sha256").update(JSON.stringify(digestInput)).digest("hex");
    return createPreview(store, {
      principalId,
      requestDigest,
      capabilityRevisionId: params.capabilityRevisionId as string,
      workspaceId: params.workspaceId as string,
      agentId: params.agentId as string,
      ttlMs,
      normalizedRequest: params.input ? { input: params.input } : {},
    });
  };

  const reconcileTask: CreateMethodsResult["reconcileTask"] = async (params: TasksReconcileParams = {}) => {
    return applyReconcileTask(getTaskEngine(), getTaskStore(), params as ReconcileTaskParams);
  };

  // Operator sign-off for a review_pending / needs_reconcile task, or for an unvalidated result with an open review attention. Deliberately not
  // exposed over MCP: accepting a delivery is a human judgement, not something the
  // calling agent may award itself.
  const resolveTask: CreateMethodsResult["resolveTask"] = async (params: TasksResolveParams = {}) => {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw validationFailed("params must be an object");
    }
    return getTaskEngine().resolve(params);
  };

  const registerAgent: CreateMethodsResult["registerAgent"] = async (params: AgentsRegisterParams = {}) => {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw validationFailed("params must be an object");
    }
    const rawCard = params.card ?? params;
    const card = normalizeCard(rawCard);
    if (!ALLOWED_ADAPTER_KINDS.has(card.identity.kind)) {
      throw validationFailed(
        `unsupported adapterKind "${card.identity.kind}"; must be one of: dsh, antigravity, codex`,
        { field: "kind", adapterKind: card.identity.kind },
      );
    }
    if (params.adapterKind !== undefined && params.adapterKind !== null) {
      const topKind = typeof params.adapterKind === "string" ? params.adapterKind.trim() : "";
      if (!ALLOWED_ADAPTER_KINDS.has(topKind)) {
        throw validationFailed("`adapterKind` must be one of: dsh, antigravity, codex", {
          field: "adapterKind",
        });
      }
      if (topKind !== card.identity.kind) {
        throw validationFailed("`adapterKind` does not match `card.identity.kind`", {
          field: "adapterKind",
        });
      }
    }
    let projectId: string | null = null;
    if (params.projectId !== undefined && params.projectId !== null) {
      if (typeof params.projectId !== "string" || params.projectId.trim().length === 0) {
        throw validationFailed("`projectId` must be a non-empty string when provided", {
          field: "projectId",
        });
      }
      projectId = params.projectId.trim();
    }
    const cardHash = hashCard(card);
    const enabled = params.enabled === undefined ? true : Boolean(params.enabled);
    const FORBIDDEN_EXEC_KEYS = new Set(["binary", "executable", "command", "argv"]);
    const containsForbiddenExecKey = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some(containsForbiddenExecKey);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_EXEC_KEYS.has(k.trim().toLowerCase())) return true;
        if (containsForbiddenExecKey(v)) return true;
      }
      return false;
    };
    const rejectAdapterConfigRef = (rawRef: unknown): string => {
      if (rawRef === undefined || rawRef === null) return "";
      if (typeof rawRef === "object") {
        if (containsForbiddenExecKey(rawRef)) {
          throw validationFailed(
            "adapter config may not select an executable; set tasksAdapters.<kind>.binary in the plugin config instead",
            { field: "adapterConfigRef" },
          );
        }
        return JSON.stringify(rawRef);
      }
      if (typeof rawRef !== "string") {
        throw validationFailed("`adapterConfigRef` must be a string or object", { field: "adapterConfigRef" });
      }
      const trimmed = rawRef.trim();
      if (!trimmed) return "";
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = null;
      }
      if (
        (parsed && containsForbiddenExecKey(parsed)) ||
        (!parsed && /(?:^|[\s,{;"'])(?:binary|executable|command|argv)\s*[:=]/i.test(trimmed))
      ) {
        throw validationFailed(
          "adapter config may not select an executable; set tasksAdapters.<kind>.binary in the plugin config instead",
          { field: "adapterConfigRef" },
        );
      }
      return trimmed;
    };
    if (params.adapterConfig !== undefined && params.adapterConfig !== null && containsForbiddenExecKey(params.adapterConfig)) {
      throw validationFailed(
        "adapter config may not select an executable; set tasksAdapters.<kind>.binary in the plugin config instead",
        { field: "adapterConfig" },
      );
    }
    const adapterConfigRef = rejectAdapterConfigRef(params.adapterConfigRef);
    const now = new Date().toISOString();
    const cancelVal = card.controls.cancel.support === "unsupported" ? "unsupported" : "supported";
    // Registration is the only external entry point that can publish a
    // capability revision, so every declared capability becomes one immutable
    // row here (id derived from card hash + capability, hence idempotent).
    const capabilityRevisions: RegisteredCapabilityRevision[] = card.capabilities.map((entry) => ({
      capabilityId: entry.capabilityId,
      version: entry.version,
      revisionId: capabilityRevisionId(cardHash, entry.capabilityId, entry.version),
      sideEffectKind: entry.sideEffectKind,
      cancelPolicy: entry.cancelPolicy,
    }));
    const storedCaps = {
      ...card,
      cardHash,
      cancel: cancelVal,
      capabilityRevisions,
      ...(projectId ? { projectId } : {}),
    };

    const store = getTaskStore();
    await store.withWriteTx((db) => {
      db.prepare(
        `INSERT INTO agents (
           agent_id, adapter_kind, adapter_config_ref, manifest_revision,
           capabilities_json, probe_status, probe_evidence_json, probe_expires_at,
           enabled, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'unverified', NULL, NULL, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           adapter_kind = excluded.adapter_kind,
           adapter_config_ref = excluded.adapter_config_ref,
           manifest_revision = excluded.manifest_revision,
           capabilities_json = excluded.capabilities_json,
           probe_status = 'unverified',
           probe_evidence_json = NULL,
           probe_expires_at = NULL,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      ).run(
        card.identity.agentId,
        card.identity.kind,
        adapterConfigRef,
        card.identity.version,
        JSON.stringify(storedCaps),
        enabled ? 1 : 0,
        now,
      );

      for (const entry of card.capabilities) {
        const revision = capabilityRevisions.find(
          (item) => item.capabilityId === entry.capabilityId && item.version === entry.version,
        )!;
        db.prepare(
          `INSERT OR IGNORE INTO capability_revisions (
             revision_id, capability, version, schema_json,
             side_effect_kind, cancel_policy, limitations_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          revision.revisionId,
          entry.capabilityId,
          String(entry.version),
          JSON.stringify(entry.schema ?? {}),
          entry.sideEffectKind,
          entry.cancelPolicy,
          JSON.stringify(entry.limitations ?? card.limitations),
          now,
        );
      }
    });

    return {
      agentId: card.identity.agentId,
      card,
      cardHash,
      capabilityRevisions,
      probeStatus: "unverified",
      enabled,
      ...(projectId ? { projectId } : {}),
    };
  };

  const listAgents: CreateMethodsResult["listAgents"] = async (params: AgentsListParams = {}) => {
    const store = getTaskStore();
    const parseCell = <T,>(text: unknown, fallback: T): T => {
      if (typeof text !== "string" || text.length === 0) return fallback;
      try {
        return JSON.parse(text) as T;
      } catch {
        return fallback;
      }
    };
    return store.read((db) => {
      const rows = db.prepare("SELECT * FROM agents ORDER BY agent_id ASC").all() as unknown as AgentRow[];
      const items: AgentsListItem[] = [];
      for (const row of rows) {
        const parsed = parseCell<Record<string, unknown>>(row.capabilities_json, {});
        const probeEvidence = parseCell<unknown>(row.probe_evidence_json, null);
        if (params.kind && row.adapter_kind !== params.kind) continue;
        if (params.enabled !== undefined && (row.enabled === 1) !== Boolean(params.enabled)) continue;
        if (params.verifiedOnly && row.probe_status !== "verified") continue;
        items.push({
          agentId: row.agent_id,
          kind: row.adapter_kind,
          manifestRevision: row.manifest_revision,
          card: parsed.cardVersion ? parsed : null,
          cardHash: typeof parsed.cardHash === "string" ? parsed.cardHash : null,
          capabilityRevisions: Array.isArray(parsed.capabilityRevisions) ? parsed.capabilityRevisions : [],
          probeStatus: row.probe_status,
          probeEvidence,
          probeExpiresAt: row.probe_expires_at ?? null,
          enabled: row.enabled === 1,
          updatedAt: row.updated_at,
        });
      }
      return { total: items.length, items };
    });
  };

  const probeAgent: CreateMethodsResult["probeAgent"] = async (params: AgentsProbeParams = {}) => {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw validationFailed("params must be an object");
    }
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId) {
      throw validationFailed("`agentId` must be a non-empty string", { field: "agentId" });
    }
    const store = getTaskStore();
    const row = store.read((db) => db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as AgentRow | undefined);
    if (!row) {
      throw notFoundError(`agent not found: ${agentId}`, { agentId });
    }
    const parsed = (() => {
      if (typeof row.capabilities_json !== "string" || row.capabilities_json.length === 0) return {} as Record<string, unknown>;
      try {
        return JSON.parse(row.capabilities_json) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })();
    const baseCard = parsed.cardVersion ? normalizeCard(parsed) : null;

    let probesForAgent: ProbeMap = {};
    if (typeof agentProbes === "function") {
      probesForAgent = (await agentProbes(row)) ?? {};
    } else if (agentProbes && typeof agentProbes === "object") {
      probesForAgent = agentProbes[agentId] ?? {};
    }

    const controls: readonly ControlName[] =
      Array.isArray(params.controls) && params.controls.length > 0
        ? (params.controls as ControlName[])
        : CONTROL_NAMES;
    const prober = createProber({
      probes: probesForAgent,
      timeoutMs: config?.tasksProbeTimeoutMs ?? 5_000,
    });
    const probeResult = await prober.probeAll(controls);
    const settleableControls = CONTROL_NAMES.filter((controlName) => {
      if (!controls.includes(controlName)) return false;
      return baseCard ? baseCard.controls[controlName].support !== "unsupported" : true;
    });
    const settledControls = settleableControls.filter(
      (controlName) => probeResult.verified[controlName] === true,
    );
    // A partially probed agent is "partial", never "verified": the whole point of
    // the card is that a claim is only verified when the control answered.
    const probeStatus: "verified" | "partial" | "unknown" =
      settleableControls.length > 0 && settledControls.length === settleableControls.length
        ? "verified"
        : settledControls.length > 0
          ? "partial"
          : "unknown";

    const evidenceLabels = Array.isArray(params.evidence)
      ? params.evidence.filter((x): x is string => typeof x === "string")
      : [];
    const updatedCard = baseCard ? withVerified(baseCard, probeResult.verified, evidenceLabels) : null;
    const cardHash = updatedCard
      ? hashCard(updatedCard)
      : typeof parsed.cardHash === "string"
        ? parsed.cardHash
        : null;
    const now = new Date().toISOString();
    const storedCaps = updatedCard
      ? {
          ...updatedCard,
          cardHash,
          cancel: updatedCard.controls.cancel.support === "unsupported" ? "unsupported" : "supported",
          // Probing refreshes evidence, never the published capability set: keep
          // the revisions this instance already declares (and its project binding).
          ...(Array.isArray(parsed.capabilityRevisions) && parsed.capabilityRevisions.length > 0
            ? { capabilityRevisions: parsed.capabilityRevisions }
            : {}),
          ...(typeof parsed.projectId === "string" && parsed.projectId ? { projectId: parsed.projectId } : {}),
        }
      : parsed;

    await store.withWriteTx((db) => {
      db.prepare(
        `UPDATE agents
         SET capabilities_json = ?,
             probe_status = ?,
             probe_evidence_json = ?,
             updated_at = ?
         WHERE agent_id = ?`,
      ).run(
        JSON.stringify(storedCaps),
        probeStatus,
        JSON.stringify({ unknown: probeResult.unknown, evidence: evidenceLabels, elapsedMs: probeResult.elapsedMs }),
        now,
        agentId,
      );
    });

    return {
      agentId,
      probeStatus,
      verifiedControls: settledControls,
      verified: probeResult.verified,
      unknown: probeResult.unknown,
      elapsedMs: probeResult.elapsedMs,
      card: updatedCard,
      cardHash,
    };
  };

  const dispatchTask: CreateMethodsResult["dispatchTask"] = async (params: TasksDispatchParams = {}) => {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw validationFailed("params must be an object");
    }
    const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
    if (!taskId) throw validationFailed("`taskId` must be a non-empty string", { field: "taskId" });
    return getTaskDispatcher().startTask({
      taskId,
      prompt: params.prompt,
      model: params.model,
      projectId: params.projectId,
      title: params.title,
    });
  };

  const pumpTask: CreateMethodsResult["pumpTask"] = async (params: TasksPumpParams = {}) => {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw validationFailed("params must be an object");
    }
    const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
    if (!taskId) throw validationFailed("`taskId` must be a non-empty string", { field: "taskId" });
    const maxSteps = params.maxSteps ?? config?.tasksDispatchMaxSteps ?? 50;
    if (typeof maxSteps !== "number" || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1_000) {
      throw validationFailed("`maxSteps` must be an integer between 1 and 1000", {
        field: "maxSteps",
        maxSteps,
      });
    }
    if (
      params.deadlineMs !== undefined &&
      (typeof params.deadlineMs !== "number" || !Number.isInteger(params.deadlineMs) || params.deadlineMs < 1)
    ) {
      throw validationFailed("`deadlineMs` must be a positive integer", {
        field: "deadlineMs",
        deadlineMs: params.deadlineMs,
      });
    }
    return getTaskDispatcher().pump({
      taskId,
      maxSteps,
      deadlineMs: params.deadlineMs,
      cursor: params.cursor,
    });
  };

  const decideApprovalTask: CreateMethodsResult["decideApprovalTask"] = async (
    params: TasksDecideApprovalParams = {},
  ) => {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw validationFailed("params must be an object");
    }
    const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
    if (!taskId) throw validationFailed("`taskId` must be a non-empty string", { field: "taskId" });
    const attemptId = typeof params.attemptId === "string" ? params.attemptId.trim() : "";
    if (!attemptId) throw validationFailed("`attemptId` must be a non-empty string", { field: "attemptId" });
    const approvalId = typeof params.approvalId === "string" ? params.approvalId.trim() : "";
    if (!approvalId) {
      throw validationFailed("`approvalId` must be a non-empty string", { field: "approvalId" });
    }
    if (params.decision !== "allow" && params.decision !== "deny") {
      throw validationFailed('`decision` must be "allow" or "deny"', {
        field: "decision",
        decision: params.decision,
      });
    }
    const mappedDecision = params.decision === "allow" ? "allow-once" : "reject";
    const note = typeof params.reason === "string" ? params.reason : undefined;
    const decidedBy =
      typeof params.decidedBy === "string" && params.decidedBy.trim() ? params.decidedBy.trim() : "operator";
    const idempotencyKey =
      typeof params.idempotencyKey === "string" && params.idempotencyKey.trim()
        ? params.idempotencyKey.trim()
        : `rpc-decide:${approvalId}`;

    return getTaskEngine().decideApproval({
      taskId,
      attemptId,
      approvalId,
      decision: mappedDecision,
      note,
      decidedBy,
      idempotencyKey,
    });
  };

  const handlers: Record<MethodName, RpcMethodHandler> = {
    "dsh.discover": (params) => discover(params),
    "dsh.ping": (params) => ping(params),
    "dsh.models": (params) => models(params),
    "dsh.workspaces.list": (params) => listWorkspaces(params),
    "dsh.workspaces.create": (params) => createWorkspace(params),
    "dsh.permissions.catalog": (params) => permissionCatalog(params),
    "dsh.approvals.pending": (params, context) => approvalsPending(params, context),
    "dsh.approvals.resolve": (params) => approvalsResolve(params),
    "dsh.sessions.configure": (params) => configure(params),
    "dsh.sessions.list": (params) => listSessions(params),
    "dsh.sessions.create": (params) => createSessionMethod(params),
    "dsh.sessions.ask": (params, context) => ask(params, context),
    "dsh.sessions.prompt": (params) => prompt(params),
    "dsh.sessions.wait": (params, context) => wait(params, context),
    "dsh.sessions.cancel": (params) => cancel(params),
    "dsh.sessions.history": (params) => history(params),
    "dsh.capabilities": (params) => capabilities(params),
    "dsh.tasks.submit": (params) => submitTask(params),
    "dsh.tasks.get": (params) => getTask(params),
    "dsh.tasks.list": (params) => listTasks(params),
    "dsh.tasks.events": (params) => taskEvents(params),
    "dsh.tasks.input": (params) => inputTask(params),
    "dsh.tasks.readArtifact": (params) => readArtifactTask(params),
    "dsh.agents.get": (params) => getAgent(params),
    "dsh.tasks.cancel": (params) => cancelTask(params),
    "dsh.tasks.preview": (params) => previewTask(params),
    "dsh.tasks.reconcile": (params) => reconcileTask(params),
    "dsh.tasks.resolve": (params) => resolveTask(params),
    "dsh.agents.register": (params) => registerAgent(params),
    "dsh.agents.list": (params) => listAgents(params),
    "dsh.agents.probe": (params) => probeAgent(params),
    "dsh.tasks.dispatch": (params) => dispatchTask(params),
    "dsh.tasks.pump": (params) => pumpTask(params),
    "dsh.tasks.decideApproval": (params) => decideApprovalTask(params),
  };

  return {
    context: { runs },

    /**
     * The circuit breaker, read by the RPC carrier so a disabled task centre
     * answers "unknown method" instead of quietly accepting work into a store
     * that will not survive a restart.
     */
    get tasksEnabled() {
      return config.tasksEnabled === true;
    },

    handlers,
    discover,
    ping,
    models,
    /**
     * The workspaces the Host shows in its sidebar. Only `list()` is a pure
     * projection; `status()` touches the filesystem, so a workspace whose
     * directory vanished reports `missing-dir` instead of failing the whole call.
     */
    listWorkspaces,
    /**
     * Register a directory as a workspace. The registry canonicalizes through
     * `fs.realpath` and reuses an existing record for the same canonical path, so
     * this is safe to call before every session a caller wants to pin somewhere.
     */
    createWorkspace,
    /**
     * The permission postures this deployment offers. Each preset is a sandbox
     * mode plus an approval policy; a caller picks one by name rather than
     * inventing knob combinations the deployment never declared.
     */
    permissionCatalog,
    configure,
    /**
     * What is waiting for the caller's decision. `waitMs` turns this into a
     * long poll so a dispatcher can sit in one call instead of polling.
     */
    approvalsPending,
    /**
     * Answer one pending escalation. `allow-once` widens that session's preset
     * for the rest of its life (the Host grants escalations per call, but the
     * only lever this bridge has is the session preset), so it is capped per
     * session in lib/approvals.mjs.
     */
    approvalsResolve,
    listSessions,
    createSession: createSessionMethod,
    ask,
    prompt,
    wait,
    cancel,
    history,
    capabilities,
    submitTask,
    getTask,
    listTasks,
    taskEvents,
    inputTask,
    readArtifactTask,
    getAgent,
    cancelTask,
    previewTask,
    reconcileTask,
    resolveTask,
    registerAgent,
    listAgents,
    probeAgent,
    dispatchTask,
    pumpTask,
    decideApprovalTask,
  };
}


// ----------------------------------------------------------------- re-exports --
// 这些名字原先是本文件的顶层导出；搬到 ./methods/*.mts 之后仍然从这里可见。
export * from "./methods/types.mjs";
export * from "./methods/catalog.mjs";
export * from "./methods/adapter-ops.mjs";
export * from "./methods/helpers.mjs";