// 从 src/lib/methods.mts 原样搬出：METHOD_CATALOG 与 RPC 契约表
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
  ActiveRunRecord,
  AgentsGetParams,
  AgentsGetResult,
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
  CapabilitiesParams,
  CapabilitiesResult,
  DEFAULT_HISTORY_BUDGET_MS,
  DiscoverParams,
  DiscoverResult,
  ITERATOR_RETURN_MS,
  MethodCatalogEntrySpec,
  ModelsParams,
  ModelsResult,
  PermissionsCatalogParams,
  PermissionsCatalogResult,
  PingParams,
  PingResult,
  SessionControllerLike,
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
  WorkspacesCreateParams,
  WorkspacesCreateResult,
  WorkspacesListParams,
  WorkspacesListResult,
  closeWithin,
  nextWithin,
} from "./types.mjs";
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

export const METHOD_CATALOG = [
  {
    name: "dsh.discover",
    summary: "Return this method catalog, the running config, and the transport map.",
    params: {},
    returns: "{ plugin, version, protocol, config, transport, methods }",
  },
  {
    name: "dsh.ping",
    summary: "Liveness, version, mounted path, config projection and active runs.",
    params: {},
    returns: "{ ok, plugin, version, protocol, origin, config, state, activeRuns }",
  },
  {
    name: "dsh.models",
    summary: "List routable providers and models for this profile.",
    params: {},
    returns: "{ default, routableProviders, groups, failures }",
  },
  {
    name: "dsh.workspaces.list",
    summary:
      "List the durable workspaces the Host shows in its sidebar, in display order, with the directory each one owns.",
    params: {},
    returns: "{ total, items: [{ id, title, path, status, sessions, createdAt, updatedAt }] }",
  },
  {
    name: "dsh.workspaces.create",
    summary: "Register an existing directory as a workspace (idempotent for the same canonical path).",
    params: { path: "string (required, absolute)", title: "string (optional)" },
    returns: "{ id, title, path }",
  },
  {
    name: "dsh.permissions.catalog",
    summary:
      "List the permission presets this deployment exposes, each expanding to a sandbox mode and an approval policy.",
    params: {},
    returns: "{ defaultPreset, options: [{ value, name, description? }], defaultOptions }",
  },
  {
    name: "dsh.approvals.pending",
    summary:
      "List sandbox escalations waiting for the caller's decision. `waitMs` makes it a long poll (<=120 s), so a dispatcher can wait in one call instead of polling.",
    params: { sessionId: "string (optional)", waitMs: "number (optional, 0..120000)" },
    returns: "{ pending: [{ approvalId, sessionId, toolName, callId, escalation, argv, cwd, preset, reason, createdAt, expiresAt }], count, timedOut, mode, deadlineMs }",
  },
  {
    name: "dsh.approvals.resolve",
    summary:
      'Answer one pending escalation. "allow-once" widens that session\'s permission preset (capped per session); "reject" refuses it.',
    params: {
      approvalId: "string (required)",
      decision: '"allow-once" | "reject" (required)',
      note: "string (optional)",
    },
    returns: "{ approvalId, sessionId, toolName, decision, note }",
  },
  {
    name: "dsh.sessions.configure",
    summary:
      "Retune an existing session: model, reasoning effort, permission preset. Applies to that session's next turn.",
    params: {
      sessionId: "string (required)",
      model: "'provider/model' or bare model id (optional)",
      reasoningEffort: "string (optional)",
      permissionPreset: "string (optional)",
    },
    returns: "{ sessionId, selected: { provider, model, reasoningEffort? }?, permissionPreset? }",
  },
  {
    name: "dsh.sessions.list",
    summary: "List Harness sessions visible to the Host, newest first as the Host orders them.",
    params: { limit: "number (default 50)" },
    returns: "{ total, items: SessionSummary[] }",
  },
  {
    name: "dsh.sessions.create",
    summary: "Create a blank session without prompting it.",
    params: {
      workspaceId: "string (optional; exclusive with cwd)",
      cwd: "string (optional)",
      agentPreset: "string (optional)",
      model: "string (optional)",
      reasoningEffort: "string (optional)",
      permissionPreset: "string (optional)",
    },
    returns: "{ sessionId, agentPreset, cwd }",
  },
  {
    name: "dsh.sessions.ask",
    summary:
      "Create (or reuse) a session, apply optional model/permission settings, submit one prompt, and wait for that turn to finish. Returns the assistant text plus tool calls, usage and the turn-end reason.",
    params: {
      text: "string (required)",
      sessionId: "string (optional; omit to create a fresh session)",
      workspaceId: "string (optional; exclusive with cwd, new sessions only)",
      cwd: "string (optional)",
      agentPreset: "string (optional)",
      model: "string (optional)",
      reasoningEffort: "string (optional)",
      permissionPreset: "string (optional)",
      mode: "'queue' | 'steer' (default 'queue')",
      queue: "boolean (default false; true waits for the session when another run is prompting it)",
      timeoutMs: "number (default 600000, max 3600000)",
    },
    returns:
      "{ sessionId, turn, status, reason, text, reasoning?, tools[], usage?, durationMs, timedOut, created }",
  },
  {
    name: "dsh.sessions.prompt",
    summary:
      "Submit a prompt without waiting for the turn to finish (fire and forget). Does not reserve the session, so a concurrent ask may still claim the turn — follow it with dsh.sessions.wait if the result matters.",
    params: {
      sessionId: "string (required)",
      text: "string (required)",
      mode: "'queue' | 'steer'",
      model: "string (optional)",
      reasoningEffort: "string (optional; needs `model`)",
      permissionPreset: "string (optional)",
    },
    returns: "{ accepted, sessionId, requestId, mode, selected?, permissionPreset? }",
  },
  {
    name: "dsh.sessions.wait",
    summary: "Wait for the turn already running on a session and return its result.",
    params: { sessionId: "string (required)", timeoutMs: "number (optional)" },
    returns: "same shape as dsh.sessions.ask",
  },
  {
    name: "dsh.sessions.cancel",
    summary: "Cancel the in-flight turn of a session.",
    params: { sessionId: "string (required)" },
    returns: "{ accepted, sessionId }",
  },
  {
    name: "dsh.sessions.history",
    summary: "Read the recent event window of a session without activating its agent.",
    params: {
      sessionId: "string (required)",
      limit: "number (default 40, max 500)",
      since: "number (optional; return only events with seq > since)",
      kinds: 'string[] | "*" (optional; event type allowlist, "*" for all)',
      maxChars: "number (optional; 0 for unlimited, positive integer caps serialized records)",
    },
    returns: "{ sessionId, cursor, turn, running, records[], truncated? }",
  },
  {
    name: "dsh.capabilities",
    summary:
      "Read-only self-description of what this Harness can do right now across eight sections. " +
      "`unavailable` means this host does not expose that fact here — not that it does not exist.",
    params: {
      sections: 'string[] | "*" (optional; section ids to collect, default ["*"])',
      max_chars: "number (optional; integer 0..40000, default 8000, 0 = uncapped)",
      session_id: "string (optional; adds caller session facts to permissions and sessions)",
    },
    returns: "{ sections[], text, truncated, missing[] }",
  },
  {
    name: "dsh.tasks.submit",
    summary:
      "Idempotently submit a task to the task-center ledger (creates queued task + mandate snapshot, no adapter dispatch yet).",
    params: {
      idempotencyKey: "string (required; deduplicated per principalId)",
      previewId: "string (optional; binds normalized request, agentId and capabilityRevisionId)",
      capabilityRevisionId: "string (optional; required if previewId omitted)",
      workspaceId: "string (optional; required if previewId omitted)",
      agentId: "string (optional; required if previewId omitted)",
      principalId: "string (optional; defaults to local-operator)",
      input: "object (optional)",
    },
    returns:
      "{ taskId, status, stateVersion, phase, phaseLabel, agentId, workspaceId, capabilityRevisionId, mandateId, deduplicated, createdAt }",
  },
  {
    name: "dsh.tasks.get",
    summary:
      "Read a task's authoritative state, derived phase, active attempt, pending attention/approvals, and artifacts.",
    params: {
      taskId: "string (required)",
      principalId: "string (optional)",
    },
    returns:
      "{ taskId, status, stateVersion, phase, phaseLabel, activeAttempt, pending: { attention[], approvals[] }, artifacts[], notice?, lastEvent, createdAt, updatedAt, completedAt }",
  },
  {
    name: "dsh.tasks.list",
    summary: "List tasks with optional status, workspace, or principal filters and cursor pagination.",
    params: {
      status: "string (optional)",
      workspaceId: "string (optional)",
      principalId: "string (optional)",
      cursor: "string (optional; opaque nextCursor from previous response)",
      limit: "number (optional; 1..200, default 50)",
    },
    returns: "{ items: TaskDetail[], nextCursor, hasMore }",
  },
  {
    name: "dsh.tasks.events",
    summary: "Read a task's own event log after a cursor (taskId + seq is the dedupe key).",
    params: {
      taskId: "string (required)",
      afterSeq: "number (optional; 0.., default 0)",
      limit: "number (optional; 1..500, default 100)",
    },
    returns: "{ taskId, events: [{ seq, type, at, attemptId?, data }], nextAfterSeq, hasMore }",
  },
  {
    name: "dsh.tasks.input",
    summary:
      "Record a human answer for a waiting task. Delivery is asynchronous: the dispatcher hands the text to the runtime and moves the task back to running.",
    params: {
      taskId: "string (required)",
      text: "string (required)",
      idempotencyKey: "string (required)",
      attemptId: "string (optional; must be the active attempt)",
      questionId: "string (optional; must still be open)",
      principalId: "string (optional)",
    },
    returns: "{ inputId, taskId, attemptId, deliveryStatus, operationId, deduplicated }",
  },
  {
    name: "dsh.tasks.readArtifact",
    summary: "Read a recorded artifact of a task by id, with an optional byte window.",
    params: {
      taskId: "string (required)",
      artifactId: "string (required)",
      offset: "number (optional; 0.., default 0)",
      length: "number (optional; 1..1000000, default 20000)",
    },
    returns: "{ taskId, artifactId, kind, sizeBytes, sha256, sourcePath, createdAt, encoding, content, offset, bytesRead, truncated }",
  },
  {
    name: "dsh.agents.get",
    summary: "Read one registered agent: its card, published capability revisions and probe status.",
    params: { agentId: "string (required)" },
    returns: "{ agentId, adapterKind, enabled, projectId, probeStatus, probeExpiresAt, registeredAt, updatedAt, card, capabilityRevisions }",
  },
  {
    name: "dsh.tasks.cancel",
    summary:
      "Durably register a cancellation request (transitions to cancel_requested, or needs_reconcile with cancel.unsupported if the executor lacks cancel capability).",
    params: {
      taskId: "string (required)",
      expectedStateVersion: "number (required; positive integer optimistic lock)",
      idempotencyKey: "string (required)",
      reason: "string (optional)",
      principalId: "string (optional)",
    },
    returns:
      "{ requestAccepted, taskId, status, stateVersion, operationId, unsupported, notice?, deduplicated }",
  },
  {
    name: "dsh.tasks.preview",
    summary:
      "Create a single-use, TTL-bounded preview binding requestDigest, agentId, workspaceId, and capabilityRevisionId for dsh.tasks.submit.",
    params: {
      principalId: "string (optional; defaults to local-operator)",
      capabilityRevisionId: "string (required)",
      workspaceId: "string (required)",
      agentId: "string (required)",
      requestDigest: "string (optional; computed from normalized request if omitted)",
      input: "object (optional)",
      ttlMs: "number (optional; positive integer ms, defaults to config.tasksPreviewTtlMs)",
    },
    returns:
      "{ previewId, expiresAt, requestDigest, agentId, workspaceId, capabilityRevisionId }",
  },
  {
    name: "dsh.tasks.reconcile",
    summary:
      "Reconcile a needs_reconcile or cancel_requested task using observed external evidence, closing active side-effect attempts.",
    params: {
      taskId: "string (required)",
      evidence: "{ observedState: 'succeeded'|'failed'|'cancelled', note?, adapterEventId?, result?, resultValid?, failureClass? } (required)",
    },
    returns: "{ taskId, from, status, stateVersion, attemptsClosed, event }",
  },
  {
    name: "dsh.tasks.resolve",
    summary:
      "Operator sign-off: move a review_pending or needs_reconcile task to succeeded/failed/cancelled/queued, or adjudicate an unvalidated result (running/waiting_input/waiting_approval with an open review attention, promoted to review_pending first). RPC + CLI only, never MCP.",
    params: {
      taskId: "string (required)",
      expectedStateVersion: "number (required; positive integer, the version the caller saw)",
      idempotencyKey: "string (required; replays are compared by intent, not only by key)",
      disposition: "string (required; accept | reject | cancel | requeue)",
      evidenceRef: "string|object (optional; what the operator looked at)",
      note: "string (optional; why)",
      resolvedBy: "string (optional; defaults to local-operator)",
    },
    returns: "{ taskId, status, stateVersion, disposition, deduplicated? }",
  },
  {
    name: "dsh.agents.register",
    summary:
      "Validate and register an agent capability card (declared: true, verified: false until probed).",
    params: {
      card: "CapabilityCard (required; identity, controls{start,steer,cancel,inspect,approval,events}, limits?, limitations[])",
      adapterConfigRef: "string (optional)",
      enabled: "boolean (optional; default true)",
    },
    returns: "{ agentId, card, cardHash, probeStatus, enabled }",
  },
  {
    name: "dsh.agents.list",
    summary: "List registered agent capability cards and their latest probe status.",
    params: {
      kind: "string (optional)",
      enabled: "boolean (optional)",
      verifiedOnly: "boolean (optional)",
    },
    returns: "{ total, items: [{ agentId, card, cardHash, probeStatus, probeEvidence, probeExpiresAt, enabled, updatedAt }] }",
  },
  {
    name: "dsh.agents.probe",
    summary:
      "Run read-only control probes for a registered agent and record verified vs unknown controls without overwriting declared support.",
    params: {
      agentId: "string (required)",
      controls: "string[] (optional; defaults to all 6 capability controls)",
      evidence: "string[] (optional; extra probe evidence labels)",
    },
    returns: "{ agentId, probeStatus, verified, unknown, elapsedMs, card, cardHash }",
  },
  {
    name: "dsh.tasks.dispatch",
    summary:
      "Dispatch a queued task through its assigned agent adapter (queued -> dispatching -> running, or needs_reconcile on start failure).",
    params: {
      taskId: "string (required)",
      prompt: "string (optional)",
      model: "string (optional)",
      projectId: "string (optional)",
      title: "string (optional)",
    },
    returns: "{ taskId, attemptId?, status, stateVersion, locator?, dispatchFailed, warning?, error? }",
  },
  {
    name: "dsh.tasks.pump",
    summary:
      "Run a bounded inspect/events pump step on an active task and apply adapter reports to the ledger.",
    params: {
      taskId: "string (required)",
      maxSteps: "number (optional; positive integer, defaults to config.tasksDispatchMaxSteps)",
      deadlineMs: "number (optional; positive integer ms)",
      cursor: "number|string (optional)",
    },
    returns: "{ taskId, status, stateVersion, stepsProcessed, nextCursor, hitMaxSteps, timedOut, reports[] }",
  },
  {
    name: "dsh.tasks.decideApproval",
    summary:
      "Record an operator approval decision (allow or deny) for a waiting task approval and enqueue the adapter effect.",
    params: {
      taskId: "string (required)",
      attemptId: "string (required)",
      approvalId: "string (required)",
      decision: '"allow" | "deny" (required)',
      reason: "string (optional)",
      decidedBy: "string (optional)",
      idempotencyKey: "string (optional)",
    },
    returns: "{ approvalId, taskId, attemptId, decision, status, stateVersion, operationId?, deduplicated }",
  },
] as const satisfies readonly MethodCatalogEntrySpec[];

export type MethodName = (typeof METHOD_CATALOG)[number]["name"];
export type MethodCatalogEntry = Omit<MethodCatalogEntrySpec, "name"> & { readonly name: MethodName };

export interface RpcMethodContractMap {
  "dsh.discover": { params: DiscoverParams; result: DiscoverResult };
  "dsh.ping": { params: PingParams; result: PingResult };
  "dsh.models": { params: ModelsParams; result: ModelsResult };
  "dsh.workspaces.list": { params: WorkspacesListParams; result: WorkspacesListResult };
  "dsh.workspaces.create": { params: WorkspacesCreateParams; result: WorkspacesCreateResult };
  "dsh.permissions.catalog": { params: PermissionsCatalogParams; result: PermissionsCatalogResult };
  "dsh.approvals.pending": { params: ApprovalsPendingParams; result: ApprovalsPendingResult };
  "dsh.approvals.resolve": { params: ApprovalsResolveParams; result: ApprovalsResolveResult };
  "dsh.sessions.configure": { params: SessionsConfigureParams; result: SessionsConfigureResult };
  "dsh.sessions.list": { params: SessionsListParams; result: SessionsListResult };
  "dsh.sessions.create": { params: SessionsCreateParams; result: SessionsCreateResult };
  "dsh.sessions.ask": { params: SessionsAskParams; result: SessionsAskResult };
  "dsh.sessions.prompt": { params: SessionsPromptParams; result: SessionsPromptResult };
  "dsh.sessions.wait": { params: SessionsWaitParams; result: SessionsWaitResult };
  "dsh.sessions.cancel": { params: SessionsCancelParams; result: SessionsCancelResult };
  "dsh.sessions.history": { params: SessionsHistoryParams; result: SessionsHistoryResult };
  "dsh.capabilities": { params: CapabilitiesParams; result: CapabilitiesResult };
  "dsh.tasks.submit": { params: TasksSubmitParams; result: TasksSubmitResult };
  "dsh.tasks.get": { params: TasksGetParams; result: TasksGetResult };
  "dsh.tasks.list": { params: TasksListParams; result: TasksListResult };
  "dsh.tasks.events": { params: TasksEventsParams; result: TasksEventsResult };
  "dsh.tasks.input": { params: TasksInputParams; result: TasksInputResult };
  "dsh.tasks.readArtifact": { params: TasksReadArtifactParams; result: TasksReadArtifactResult };
  "dsh.agents.get": { params: AgentsGetParams; result: AgentsGetResult };
  "dsh.tasks.cancel": { params: TasksCancelParams; result: TasksCancelResult };
  "dsh.tasks.preview": { params: TasksPreviewParams; result: TasksPreviewResult };
  "dsh.tasks.reconcile": { params: TasksReconcileParams; result: TasksReconcileResult };
  "dsh.tasks.resolve": { params: TasksResolveParams; result: TasksResolveResult };
  "dsh.agents.register": { params: AgentsRegisterParams; result: AgentsRegisterResult };
  "dsh.agents.list": { params: AgentsListParams; result: AgentsListResult };
  "dsh.agents.probe": { params: AgentsProbeParams; result: AgentsProbeResult };
  "dsh.tasks.dispatch": { params: TasksDispatchParams; result: TasksDispatchResult };
  "dsh.tasks.pump": { params: TasksPumpParams; result: TasksPumpResult };
  "dsh.tasks.decideApproval": { params: TasksDecideApprovalParams; result: TasksDecideApprovalResult };
}

export type RpcMethodHandler = (params?: Record<string, unknown>, context?: RpcDispatchContext) => Promise<unknown>;

export interface CreateMethodsResult {
  readonly context: { readonly runs: Map<string, ActiveRunRecord> };
  readonly tasksEnabled: boolean;
  readonly handlers: Record<MethodName, RpcMethodHandler>;
  discover(params?: DiscoverParams): Promise<DiscoverResult>;
  ping(params?: PingParams): Promise<PingResult>;
  models(params?: ModelsParams): Promise<ModelsResult>;
  listWorkspaces(params?: WorkspacesListParams): Promise<WorkspacesListResult>;
  createWorkspace(params?: WorkspacesCreateParams): Promise<WorkspacesCreateResult>;
  permissionCatalog(params?: PermissionsCatalogParams): Promise<PermissionsCatalogResult>;
  configure(params?: SessionsConfigureParams): Promise<SessionsConfigureResult>;
  approvalsPending(params?: ApprovalsPendingParams, context?: RpcDispatchContext): Promise<ApprovalsPendingResult>;
  approvalsResolve(params?: ApprovalsResolveParams): Promise<ApprovalsResolveResult>;
  listSessions(params?: SessionsListParams): Promise<SessionsListResult>;
  createSession(params?: SessionsCreateParams): Promise<SessionsCreateResult>;
  ask(params?: SessionsAskParams, context?: RpcDispatchContext): Promise<SessionsAskResult>;
  prompt(params?: SessionsPromptParams): Promise<SessionsPromptResult>;
  wait(params?: SessionsWaitParams, context?: RpcDispatchContext): Promise<SessionsWaitResult>;
  cancel(params?: SessionsCancelParams): Promise<SessionsCancelResult>;
  history(params?: SessionsHistoryParams): Promise<SessionsHistoryResult>;
  capabilities(params?: CapabilitiesParams): Promise<CapabilitiesResult>;
  submitTask(params?: TasksSubmitParams): Promise<TasksSubmitResult>;
  getTask(params?: TasksGetParams): Promise<TasksGetResult>;
  listTasks(params?: TasksListParams): Promise<TasksListResult>;
  taskEvents(params?: TasksEventsParams): Promise<TasksEventsResult>;
  inputTask(params?: TasksInputParams): Promise<TasksInputResult>;
  readArtifactTask(params?: TasksReadArtifactParams): Promise<TasksReadArtifactResult>;
  getAgent(params?: AgentsGetParams): Promise<AgentsGetResult>;
  cancelTask(params?: TasksCancelParams): Promise<TasksCancelResult>;
  previewTask(params?: TasksPreviewParams): Promise<TasksPreviewResult>;
  reconcileTask(params?: TasksReconcileParams): Promise<TasksReconcileResult>;
  resolveTask(params?: TasksResolveParams): Promise<TasksResolveResult>;
  registerAgent(params?: AgentsRegisterParams): Promise<AgentsRegisterResult>;
  listAgents(params?: AgentsListParams): Promise<AgentsListResult>;
  probeAgent(params?: AgentsProbeParams): Promise<AgentsProbeResult>;
  dispatchTask(params?: TasksDispatchParams): Promise<TasksDispatchResult>;
  pumpTask(params?: TasksPumpParams): Promise<TasksPumpResult>;
  decideApprovalTask(params?: TasksDecideApprovalParams): Promise<TasksDecideApprovalResult>;
}

/** Every RPC method the `tasksEnabled` breaker covers. */
export const TASK_FAMILY_METHODS: ReadonlySet<string> = new Set<MethodName>([
  "dsh.tasks.input",
  "dsh.tasks.readArtifact",
  "dsh.agents.get",
  "dsh.tasks.submit",
  "dsh.tasks.get",
  "dsh.tasks.list",
  "dsh.tasks.events",
  "dsh.tasks.cancel",
  "dsh.tasks.preview",
  "dsh.tasks.reconcile",
  "dsh.tasks.dispatch",
  "dsh.tasks.pump",
  "dsh.tasks.decideApproval",
  "dsh.tasks.resolve",
  "dsh.agents.register",
  "dsh.agents.list",
  "dsh.agents.probe",
]);

export const ALLOWED_ADAPTER_KINDS: ReadonlySet<string> = new Set(["dsh", "antigravity", "codex"]);

export async function readSessionSnapshot(
  sc: SessionControllerLike,
  { sessionId, limit = 40, budgetMs = DEFAULT_HISTORY_BUDGET_MS }: { sessionId: string; limit?: number; budgetMs?: number },
): Promise<{ cursor?: number; records?: unknown[]; hasMore?: boolean; missing?: boolean }> {
  const ac = new AbortController();
  const iterator = sc.follow(
    {
      address: { kind: "session", sessionId },
      maxMessages: limit,
    },
    ac.signal,
  )[Symbol.asyncIterator]();
  const deadline = Date.now() + budgetMs;
  try {
    const first = await nextWithin(iterator, deadline, budgetMs, "reading the session snapshot");
    if (first.done || first.value?.type !== "snapshot") {
      return { cursor: -1, records: [], hasMore: false, missing: true };
    }
    return first.value;
  } finally {
    await closeWithin(iterator, ITERATOR_RETURN_MS);
  }
}

/**
 * Wrap Host `sessionController` + `approvals` into HTTP-free ops for `createDshAdapter`.
 * Every op catches failures and returns `{ ok: false, reason }` instead of throwing.
 */
