// 从 src/lib/methods.mts 原样搬出：参数与结果声明（MethodCatalogEntrySpec … CreateMethodsResult）
// 只搬不改；methods.mts 仍把这些名字 re-export，外部调用点不受影响。

// Method implementations over the Host `sessionController` service.
//
// The whole bridge rests on one observation: `sessionController.follow` is an
// AsyncIterable whose first frame is a snapshot and whose later frames are live
// events. Subscribing *before* `prompt` is admitted is what makes the result
// deterministic — we know the turn baseline first, so the turn we are waiting
// for is exactly `baseline.turn + 1` (or `baseline.turn` for a steer into a
// running turn). No polling, no racing the queue.

import { createHash, randomUUID } from "node:crypto";

// sibling-imports:begin
import {
  MethodCatalogEntry,
} from "./catalog.mjs";
// sibling-imports:end

import { createDshAdapter, type DshSessionOps } from "../adapters/dsh.mjs";
import {
  CONTROL_NAMES,
  capabilityRevisionId,
  hashCard,
  normalizeCard,
  withVerified,
  type ControlName,
  type NormalizedCard,
  type VerifiedCard,
} from "../agents/card.mjs";
import { createProber, type ProbeMap, type ProbeUnknownEntry } from "../agents/probe.mjs";
import {
  formatCapabilities,
  MAX_MAX_CHARS,
  normalizeSections,
  type NormalizedCapabilitySection,
} from "../capabilities.mjs";
import { describeConfig, type DescribedConfig, type ResolvedConfig } from "../config.mjs";
import { collectFacts } from "../host-facts.mjs";
import { type RpcDispatchContext } from "../http.mjs";
import { isOwnedSession, ownSession } from "../owned.mjs";
import { CODE, RpcError, badRequest } from "../protocol.mjs";
import { ROTATE_AFTER_ASKS, lookupEntry, registryKey, rememberEntry } from "../registry.mjs";
import type { PendingApprovalPacket } from "../pending.mjs";
import { createTaskEngine, type TaskDetail, type TaskEngine, type TaskEventsResult } from "../tasks/engine.mjs";
import { createDispatcher, type Dispatcher, type PumpResult, type StartTaskResult } from "../tasks/dispatch.mjs";
import { notFoundError, validationFailed } from "../tasks/errors.mjs";
import { createPreview, type CreatePreviewResult } from "../tasks/preview.mjs";
import {
  reconcileTask as applyReconcileTask,
  type ReconcileEvidence,
  type ReconcileTaskParams,
  type ReconcileTaskResult,
} from "../tasks/reconcile.mjs";
import { openStore, type AgentRow, type CapabilityRevisionRow, type TaskStore } from "../tasks/store.mjs";
import { type TaskStatus } from "../tasks/state-machine.mjs";
import { PLUGIN_NAME, PLUGIN_VERSION, PROTOCOL_VERSION } from "../version.mjs";

export interface MethodCatalogEntrySpec {
  readonly name: string;
  readonly summary: string;
  readonly params: Readonly<Record<string, string>>;
  readonly returns: string;
  readonly scope?: "base" | "tasks";
}

export type AskMode = "turn" | "steer" | "queue";
export type ReuseMode = "auto" | "never" | "latest";

export interface TurnEndReason {
  kind: string;
  message?: string;
  [key: string]: unknown;
}

export interface TokenUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  reasoningTokens?: number | undefined;
}

export interface CollectedToolCall {
  callId: string | null;
  name: string | null;
  arguments: unknown;
  seq: number | null;
  at: number | null;
  output?: string;
  isError?: boolean;
  endedAt?: number | null;
  ok?: boolean;
  error?: unknown;
}

export interface CollectedTurnResult {
  text: string;
  reasoning: string;
  tools: CollectedToolCall[];
  usage: TokenUsage | null;
  startedAt: number | null;
}

export interface SandboxDenial {
  denied: boolean;
  marker?: string;
  source?: "tool" | "text";
}

export interface PingTaskCentreAutopilot {
  enabled: boolean;
  intervalMs: number | null;
  maxStart: number | null;
  maxPump: number | null;
}

export interface PingTaskCentreAutopilotStats {
  passes: number;
  lastPassAt: string | null;
  lastStarted: number;
  lastPumped: number;
  lastFailed: number;
  lastError: string | null;
}

export interface PingTaskCentreProjection {
  enabled: boolean;
  mode: string;
  ready: boolean;
  dbPath: string | null;
  store: "injected" | "engine" | "lazy";
  seedError: string | null;
  startError: string | null;
  autopilot: PingTaskCentreAutopilot | null;
  autopilotStats: PingTaskCentreAutopilotStats | null;
}

export interface ActiveRunRecord {
  sessionId: string;
  startedAt: number;
  prompt: boolean;
  state: "queued" | "running";
}

export interface PingActiveRunProjection {
  sessionId: string;
  runId: string;
  prompt: boolean;
  state: "queued" | "running";
  ageMs: number;
}

export interface DiscoverParams {
  [key: string]: unknown;
}

export interface DiscoverResult {
  plugin: string;
  version: string;
  protocol: string;
  config: DescribedConfig;
  transport: {
    rpc: string;
    stream: string;
    health: string;
    auth: string;
  };
  methods: readonly MethodCatalogEntry[];
}

export interface PingParams {
  [key: string]: unknown;
}

export interface PingResult {
  ok: true;
  plugin: string;
  version: string;
  protocol: string;
  origin: string | null;
  pid: number;
  node: string;
  uptimeMs: number;
  config: DescribedConfig;
  state: {
    tokenSource: string;
    tokenPath: string | null;
    endpointPath: string | null;
  };
  taskCentre: PingTaskCentreProjection;
  activeRuns: PingActiveRunProjection[];
}

export interface ModelsParams {
  [key: string]: unknown;
}

export interface ModelsResult {
  default: unknown;
  routableProviders: unknown[];
  groups: unknown[];
  failures: unknown[];
}

export interface WorkspacesListParams {
  [key: string]: unknown;
}

export interface WorkspaceProjection {
  id: string;
  title: string;
  path: string;
  status: string;
  sessions: number;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface WorkspacesListResult {
  total: number;
  items: WorkspaceProjection[];
}

export interface WorkspacesCreateParams {
  path?: string;
  title?: string;
  [key: string]: unknown;
}

export interface WorkspacesCreateResult {
  id: string;
  title: string;
  path: string;
}

export interface PermissionsCatalogParams {
  [key: string]: unknown;
}

export interface PermissionsCatalogOption {
  value: string;
  name: string;
  description: string | null;
  cost: string | null;
}

export interface PermissionsCatalogResult {
  defaultPreset: string | null;
  options: PermissionsCatalogOption[];
  defaultOptions: string[];
}

export interface ApprovalsPendingParams {
  sessionId?: string;
  waitMs?: number;
  [key: string]: unknown;
}

export type { PendingApprovalPacket };

export interface ApprovalsPendingResult {
  pending: PendingApprovalPacket[];
  count: number;
  timedOut: boolean;
  mode: string;
  deadlineMs: number | null;
}

export interface ApprovalsResolveParams {
  approvalId?: string;
  decision?: "allow-once" | "reject" | string;
  note?: string;
  [key: string]: unknown;
}

export interface ApprovalsResolveResult {
  approvalId: string;
  sessionId: string | null;
  toolName: string | null;
  decision: "allow-once" | "reject";
  note: string | null;
}

export interface SelectedModel {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface SessionsConfigureParams {
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  permissionPreset?: string;
  [key: string]: unknown;
}

export interface SessionsConfigureResult {
  sessionId: string;
  selected?: SelectedModel;
  permissionPreset?: string;
}

export interface SessionsListParams {
  limit?: number;
  cwd?: string;
  sort?: "updatedAt" | "createdAt" | string;
  [key: string]: unknown;
}

export interface SessionSummaryItem {
  sessionId: string;
  running: boolean;
  blank: boolean;
  agentAvailable: boolean;
  updatedAt: unknown;
  createdAt: unknown;
  cwd: string | null;
  agentPreset: string | null;
  origin: unknown;
  parentSessionId: string | null;
}

export interface SessionsListResult {
  total: number;
  sort: "updatedAt" | "createdAt";
  cwd: string | null;
  items: SessionSummaryItem[];
}

export interface SessionsCreateParams {
  workspaceId?: string;
  cwd?: string;
  agentPreset?: string;
  model?: string;
  reasoningEffort?: string;
  permissionPreset?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface SessionsCreateResult {
  sessionId: string;
  agentPreset: string | null;
  cwd: string | null;
  selected?: SelectedModel;
  permissionPreset?: string;
}

export interface SessionsAskParams {
  text?: string;
  sessionId?: string;
  workspaceId?: string;
  cwd?: string;
  agentPreset?: string;
  model?: string;
  reasoningEffort?: string;
  permissionPreset?: string;
  mode?: AskMode | string;
  reuse?: ReuseMode | string;
  project?: string;
  namespace?: string;
  queue?: boolean;
  wait?: boolean;
  timeoutMs?: number;
  [key: string]: unknown;
}

export interface NextToolAdvice {
  tool: string;
  reason?: string;
  args: Record<string, unknown>;
}

export interface SessionsAskResult {
  sessionId: string;
  turn: number | null;
  status: string;
  reason?: unknown;
  partial?: boolean;
  text: string;
  reasoning?: string | undefined;
  tools?: CollectedToolCall[] | undefined;
  usage?: TokenUsage | undefined;
  durationMs?: number;
  timedOut?: boolean;
  requestId: string | null;
  mode?: AskMode;
  accepted?: boolean;
  created: boolean;
  cwd?: string | null;
  reused?: boolean;
  rotated?: boolean;
  previousSessionId?: string | null;
  selected?: SelectedModel;
  permissionPreset?: string;
  cursor?: number;
  turnStartedAt?: number | null;
  sliceMs?: number;
  requestedMs?: number;
  since?: number;
  sandbox?: SandboxDenial;
  pendingApproval?: unknown;
  next?: NextToolAdvice;
}

export interface SessionsPromptParams {
  sessionId?: string;
  text?: string;
  mode?: AskMode | string;
  workspaceId?: string;
  cwd?: string;
  agentPreset?: string;
  model?: string;
  reasoningEffort?: string;
  permissionPreset?: string;
  [key: string]: unknown;
}

export interface SessionsPromptResult {
  accepted: true;
  sessionId: string;
  requestId: string;
  mode: AskMode;
  selected?: SelectedModel;
  permissionPreset?: string;
}

export interface SessionsWaitParams {
  sessionId?: string;
  timeoutMs?: number;
  since?: number;
  [key: string]: unknown;
}

export type SessionsWaitResult = SessionsAskResult;

export interface SessionsCancelParams {
  sessionId?: string;
  [key: string]: unknown;
}

export interface SessionsCancelResult {
  accepted: boolean;
  sessionId: string;
}

export interface SessionsHistoryParams {
  sessionId?: string;
  limit?: number;
  since?: number;
  kinds?: string[] | "*" | null;
  maxChars?: number;
  [key: string]: unknown;
}

export interface ProjectedSessionEvent {
  type: string;
  seq: number | null;
  time: number | null;
  data: unknown;
}

export interface SessionsHistoryResult {
  sessionId: string;
  cursor: number;
  turn?: number;
  running?: boolean;
  messageCount?: number;
  hasMore?: boolean;
  records: Array<ProjectedSessionEvent | null>;
  truncated?: boolean;
}

export interface CapabilitiesParams {
  sections?: string[] | "*" | null;
  max_chars?: number;
  maxChars?: number;
  session_id?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface CapabilitiesResult {
  sections: NormalizedCapabilitySection[];
  text: string;
  truncated: boolean;
  missing: string[];
}

export interface TasksSubmitParams {
  idempotencyKey?: string;
  previewId?: string;
  capabilityRevisionId?: string;
  workspaceId?: string;
  agentId?: string;
  principalId?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

export type TasksSubmitResult = Record<string, unknown>;

export interface TasksGetParams {
  taskId?: string;
  principalId?: string;
  [key: string]: unknown;
}

export type TasksGetResult = TaskDetail;

export interface TasksListParams {
  status?: TaskStatus | string;
  workspaceId?: string;
  principalId?: string;
  cursor?: string;
  limit?: number;
  [key: string]: unknown;
}

export interface TasksListResult {
  items: TaskDetail[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TasksEventsParams {
  taskId?: string;
  afterSeq?: number;
  limit?: number;
  [key: string]: unknown;
}

export type TasksEventsResult = TaskEventsResult;

export interface TasksInputParams {
  taskId?: string;
  text?: string;
  idempotencyKey?: string;
  attemptId?: string;
  questionId?: string;
  principalId?: string;
  [key: string]: unknown;
}

export type TasksInputResult = Record<string, unknown>;

export interface TasksReadArtifactParams {
  taskId?: string;
  artifactId?: string;
  offset?: number;
  length?: number;
  [key: string]: unknown;
}

export type TasksReadArtifactResult = Record<string, unknown>;

export interface AgentsGetParams {
  agentId?: string;
  [key: string]: unknown;
}

export interface AgentCapabilityRevisionSummary {
  revisionId: string;
  capability: string;
  version: string;
  sideEffectKind: string;
  cancelPolicy: string;
  limitations: unknown;
  createdAt: string;
}

export interface AgentsGetResult {
  agentId: string;
  adapterKind: string;
  enabled: boolean;
  projectId: string | null;
  probeStatus: string | null;
  probeExpiresAt: string | null;
  registeredAt: string | null;
  updatedAt: string | null;
  card: unknown;
  capabilityRevisions: AgentCapabilityRevisionSummary[];
}

export interface TasksCancelParams {
  taskId?: string;
  expectedStateVersion?: number;
  idempotencyKey?: string;
  reason?: string;
  principalId?: string;
  [key: string]: unknown;
}

export type TasksCancelResult = Record<string, unknown>;

export interface TasksPreviewParams {
  principalId?: string;
  capabilityRevisionId?: string;
  workspaceId?: string;
  agentId?: string;
  requestDigest?: string;
  input?: Record<string, unknown>;
  ttlMs?: number;
  [key: string]: unknown;
}

export type TasksPreviewResult = CreatePreviewResult;

export interface TasksReconcileParams {
  taskId?: string;
  evidence?: ReconcileEvidence;
  [key: string]: unknown;
}

export type TasksReconcileResult = ReconcileTaskResult;

export interface TasksResolveParams {
  taskId?: string;
  expectedStateVersion?: number;
  idempotencyKey?: string;
  disposition?: "accept" | "reject" | "cancel" | "requeue" | string;
  evidenceRef?: string | Record<string, unknown>;
  note?: string;
  resolvedBy?: string;
  [key: string]: unknown;
}

export type TasksResolveResult = Record<string, unknown>;

export interface RegisteredCapabilityRevision {
  capabilityId: string;
  version: number;
  revisionId: string;
  sideEffectKind: "read" | "write";
  cancelPolicy: "required" | "optional";
}

export interface AgentsRegisterParams {
  card?: Record<string, unknown>;
  adapterKind?: string;
  projectId?: string;
  adapterConfig?: Record<string, unknown>;
  adapterConfigRef?: string | Record<string, unknown>;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface AgentsRegisterResult {
  agentId: string;
  card: NormalizedCard;
  cardHash: string;
  capabilityRevisions: RegisteredCapabilityRevision[];
  probeStatus: "unverified";
  enabled: boolean;
  projectId?: string;
}

export interface AgentsListParams {
  kind?: string;
  enabled?: boolean;
  verifiedOnly?: boolean;
  [key: string]: unknown;
}

export interface AgentsListItem {
  agentId: string;
  kind: string;
  manifestRevision: string | null;
  card: unknown;
  cardHash: string | null;
  capabilityRevisions: unknown[];
  probeStatus: string | null;
  probeEvidence: unknown;
  probeExpiresAt: string | null;
  enabled: boolean;
  updatedAt: string | null;
}

export interface AgentsListResult {
  total: number;
  items: AgentsListItem[];
}

export interface AgentsProbeParams {
  agentId?: string;
  controls?: ControlName[] | string[];
  evidence?: string[];
  [key: string]: unknown;
}

export interface AgentsProbeResult {
  agentId: string;
  probeStatus: "verified" | "partial" | "unknown";
  verifiedControls: ControlName[];
  verified: Partial<Record<ControlName, boolean>>;
  unknown: ProbeUnknownEntry[];
  elapsedMs: number;
  card: VerifiedCard | null;
  cardHash: string | null;
}

export interface TasksDispatchParams {
  taskId?: string;
  prompt?: string;
  model?: string;
  projectId?: string;
  title?: string;
  [key: string]: unknown;
}

export type TasksDispatchResult = StartTaskResult;

export interface TasksPumpParams {
  taskId?: string;
  maxSteps?: number;
  deadlineMs?: number;
  cursor?: number | string;
  [key: string]: unknown;
}

export type TasksPumpResult = PumpResult;

export interface TasksDecideApprovalParams {
  taskId?: string;
  attemptId?: string;
  approvalId?: string;
  decision?: "allow" | "deny" | string;
  reason?: string;
  decidedBy?: string;
  idempotencyKey?: string;
  [key: string]: unknown;
}

export type TasksDecideApprovalResult = Record<string, unknown>;

// How long a run waits for the Host iterator to acknowledge `return()` before it
// stops caring. Cleanup is best-effort; the caller's answer never waits on it.
export const ITERATOR_RETURN_MS = 1_000;

export const MAX_TIMEOUT_MS = 60 * 60 * 1000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_WAIT_RECORDS = 500;

/** Used when no config reached this module (tests build one explicitly). */
export const DEFAULT_HISTORY_BUDGET_MS = 30_000;

export interface SessionControllerFollowFrame {
  type?: string;
  cursor?: number;
  records?: unknown[];
  hasMore?: boolean;
  event?: Record<string, unknown>;
  frame?: unknown;
}

export interface SessionControllerListedItem {
  sessionId: string;
  running?: boolean;
  blank?: boolean;
  agentAvailable?: boolean;
  updatedAt?: unknown;
  createdAt?: unknown;
  cwd?: string | null;
  projections?: { agentPreset?: string | null } | null;
  origin?: unknown;
  parentSessionId?: string | null;
}

export interface SessionControllerLike {
  follow(request: { address: { kind: "session"; sessionId: string }; maxMessages: number }, signal?: AbortSignal): AsyncIterable<SessionControllerFollowFrame>;
  create(request: Record<string, unknown>): Promise<{ sessionId?: string; agentPreset?: string | null } | null | undefined>;
  inspect?(sessionId: string, signal?: AbortSignal): Promise<{ meta?: { cwd?: string } } | null | undefined>;
  selectModel?(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<{ selected?: SelectedModel } | null | undefined>;
  modelCatalog?(): Promise<{
    default?: unknown;
    routableProviders?: unknown[];
    groups?: Array<{ id: string; models?: Array<{ id?: string }> }>;
    failures?: unknown[];
  } | null | undefined>;
  prompt(request: { requestId: string; sessionId: string; mode: string; content: Array<{ type: "text"; text: string }> }, signal?: AbortSignal): Promise<unknown>;
  cancel(request: { sessionId: string }): Promise<{ accepted?: boolean; stopped?: boolean } | null | undefined>;
  list(request: Record<string, unknown>, signal?: AbortSignal): Promise<{ items?: SessionControllerListedItem[] } | null | undefined>;
  resolveAgent?(sessionId: string): Promise<{ error?: unknown } | null | undefined>;
}

export interface ApprovalsServiceLike {
  open?: boolean | ((...args: unknown[]) => unknown);
  waitForAny?(options: {
    sessionId?: string | undefined;
    waitMs?: number | undefined;
    signal?: AbortSignal | null | undefined;
  }): Promise<{
    pending: PendingApprovalPacket[];
    timedOut?: boolean;
  }>;
  pending?(sessionId?: string): Promise<PendingApprovalPacket[]> | PendingApprovalPacket[];
  resolve(approvalId: string, decision: "allow-once" | "reject", note?: string | null): {
    resolved?: boolean | undefined;
    sessionId?: string | null | undefined;
    toolName?: string | null | undefined;
  };
  watch?(sessionId: string): {
    promise: Promise<PendingApprovalPacket>;
    cancel(): void;
  };
}

export interface HostServiceContextLike {
  get?(name: string): unknown;
  logger?: unknown;
}

export interface WebServerLike {
  getOrigin?(): string | null;
}

export interface TaskCentreStatusLike {
  enabled?: boolean;
  mode?: string;
  ready?: boolean;
  dbPath?: string | null;
  seedError?: string | null;
  startError?: string | null;
  lazyStore?: boolean;
  autopilot?: PingTaskCentreAutopilot | null;
  autopilotStats?: PingTaskCentreAutopilotStats | null;
}

export interface BridgeRuntimeStateLike {
  tokenSource?: string;
  tokenPath?: string | null;
  endpointPath?: string | null;
}

export interface CreateMethodsDeps {
  sessionController: SessionControllerLike | null | undefined;
  webServer?: WebServerLike | null;
  approvals?: ApprovalsServiceLike | null;
  taskStore?: TaskStore | null;
  taskEngine?: TaskEngine | null;
  agentProbes?:
    | ((row: AgentRow) => Promise<ProbeMap> | ProbeMap)
    | Record<string, ProbeMap>
    | null;
  adapters?: Record<string, unknown> | null;
  taskDispatcher?: Dispatcher | null;
  taskCentre?: TaskCentreStatusLike | null;
}

/**
 * One iterator frame, but never longer than the remaining budget.
 *
 * `history` is a bounded read — one snapshot — so a frame that never arrives is
 * a Host that stopped answering, and the caller deserves a timeout instead of a
 * request that hangs forever (F-4: `history` had no deadline at all).
 */
export async function nextWithin<T>(
  iterator: AsyncIterator<T>,
  deadline: number,
  budget: number,
  what: string,
): Promise<IteratorResult<T>> {
  const remaining = deadline - Date.now();
  const line = `${what} took longer than ${budget} ms; the Harness stopped answering`;
  if (remaining <= 0) throw new RpcError(CODE.timeout, line);
  let handle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new RpcError(CODE.timeout, line)), remaining);
        handle = timer;
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

/**
 * Close an iterator without letting cleanup decide when the answer arrives.
 *
 * Same reasoning as the bounded `iterator.return()` inside `drive()`: a stream
 * parked in a long `next()` never resolves its teardown, and the caller would
 * wait for a request whose result is already in hand.
 */
export async function closeWithin(iterator: AsyncIterator<unknown> | null | undefined, ms: number): Promise<void> {
  if (!iterator || typeof iterator.return !== "function") return;
  const closed = Promise.resolve()
    .then(() => iterator.return!())
    .catch(() => {});
  let handle: ReturnType<typeof setTimeout> | null = null;
  const bound = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    handle = timer;
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    await Promise.race([closed, bound]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

// `dsh_ask`'s `mode`. `turn` is this bridge's own rule ("only into an idle
// session") and never reaches the Host — see `drive()`.
export const ASK_MODES: readonly AskMode[] = ["turn", "steer", "queue"];
// `reuse`. `auto` = sticky lookup, `never` = always a new session, `latest` =
// ignore the stored mapping and take the most recently updated session for the
// key's scope.
export const REUSE_MODES: readonly ReuseMode[] = ["auto", "never", "latest"];

// A tool's output is carried back so a sandbox refusal can be recognised, but
// one chatty command must not turn a result into megabytes of JSON.
export const TOOL_OUTPUT_LIMIT = 4000;

// Per-tool truncation alone is not a bound: a turn with a hundred tool calls
// would still ship 400 KB into the caller's context. The turn gets one budget.
export const TOOL_OUTPUT_BUDGET = 20000;

// The sandbox appends a fixed sentence to a refused tool call. Matching that
// exact prefix — rather than words like "denied" or "permission" — is what keeps
// the escalation hint from firing on ordinary error text.
export const SANDBOX_DENIED_MARKER = "[sandbox: file access denied";

// The only mode that is strictly wider than `workspace-write` (the default
// preset): the Host's sandbox ladder is closed, and every preset that grants
// more than the workspace is this one.
export const ESCALATION_PRESET = "danger-full-access";

// What a preset costs, in the caller's own terms. A deployment may declare its
// own names, so anything unrecognised keeps `cost: null` instead of a guess.
export const PRESET_COST: Record<string, string> = {
  "read-only": "read-only sandbox: every write fails, and there is no approval path",
  "workspace-write": "writes inside the session workspace; leaving it requires approval",
  "danger-full-access":
    "full disk access with approvals disabled — nothing else restricts this turn, so it is the last resort after a denial",
  auto: "deployment-defined automatic posture; ask the operator what it expands to",
};

/** Self-description served by `dsh.discover`, so a caller never has to guess. */
