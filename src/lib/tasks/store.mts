// Durable SQLite store for the DSH local agent task center (§5.1).
//
// Uses Node's built-in `node:sqlite` (`DatabaseSync`, Node >=22.13 / >=24) so
// the plugin keeps zero runtime dependencies. Every write transaction uses
// `BEGIN IMMEDIATE` with bounded busy retry and per-handle serialization.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { TASK_ERROR, taskError, validationFailed } from "./errors.mjs";
import type { TaskStatus } from "./state-machine.mjs";

export const SCHEMA_VERSION = 1 as const;

export type AttentionKind = "decision" | "input" | "approval" | "review";

export interface SchemaMetaRow {
  version: number;
  updated_at: string;
}

export interface PrincipalRow {
  principal_id: string;
  kind: string;
  scopes_json: string;
  credential_hash: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceRow {
  workspace_id: string;
  root_path: string;
  allowed_side_effects_json: string;
  policy_json: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRow {
  agent_id: string;
  adapter_kind: string;
  adapter_config_ref: string;
  manifest_revision: string;
  capabilities_json: string;
  probe_status: string;
  probe_evidence_json: string | null;
  probe_expires_at: string | null;
  enabled: number;
  updated_at: string;
}

export interface CapabilityRevisionRow {
  revision_id: string;
  capability: string;
  version: string;
  schema_json: string;
  side_effect_kind: string;
  cancel_policy: string;
  limitations_json: string;
  created_at: string;
}

export interface PreviewRow {
  preview_id: string;
  principal_id: string;
  normalized_request_json: string;
  candidates_json: string;
  selected_agent_id: string | null;
  selection_reason: string | null;
  policy_revision: string | null;
  capability_revision_id: string | null;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface TaskRow {
  task_id: string;
  principal_id: string;
  idempotency_key: string;
  request_hash: string;
  capability_revision_id: string;
  workspace_id: string;
  agent_id: string;
  preview_id: string | null;
  request_summary_json: string;
  status: TaskStatus;
  state_version: number;
  active_attempt_id: string | null;
  cancel_requested_at: string | null;
  cancel_reason: string | null;
  source_task_id: string | null;
  result_json: string | null;
  result_valid: number | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface MandateRow {
  mandate_id: string;
  principal_id: string;
  task_id: string;
  workspace_id: string;
  agent_id: string;
  allowed_ops_json: string;
  policy_revision: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface AttemptRow {
  attempt_id: string;
  task_id: string;
  attempt_no: number;
  agent_id: string;
  mandate_id: string | null;
  capability_revision_id: string;
  runtime_locator_json: string | null;
  status: string;
  failure_class: string | null;
  side_effect_active: number;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface EventRow {
  event_id: string;
  task_id: string;
  seq: number;
  attempt_id: string | null;
  type: string;
  source: string;
  adapter_event_id: string | null;
  payload_json: string;
  evidence_json: string | null;
  created_at: string;
}

export interface EffectRow {
  operation_id: string;
  task_id: string;
  attempt_id: string | null;
  op_type: string;
  idempotency_key: string | null;
  request_summary_json: string;
  status: string;
  lease_expires_at: string | null;
  receipt_json: string | null;
  reconcile_result_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface InputRow {
  input_id: string;
  task_id: string;
  attempt_id: string;
  question_id: string | null;
  idempotency_key: string;
  text: string;
  delivery_status: string;
  evidence_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRow {
  approval_id: string;
  task_id: string;
  attempt_id: string;
  scope_json: string;
  summary: string;
  status: string;
  decision: string | null;
  decided_by: string | null;
  decision_note: string | null;
  idempotency_key: string | null;
  expires_at: string;
  created_at: string;
  decided_at: string | null;
}

export interface ArtifactRow {
  artifact_id: string;
  task_id: string;
  attempt_id: string | null;
  kind: string;
  size_bytes: number;
  sha256: string | null;
  source_path: string | null;
  access_policy_json: string;
  created_at: string;
}

export interface AttentionRow {
  question_id: string;
  task_id: string;
  attempt_id: string | null;
  kind: AttentionKind;
  prompt: string;
  options_json: string;
  status: string;
  expires_at: string | null;
  resolved_by: string | null;
  resolution_json: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface TableRowMap {
  schema_meta: SchemaMetaRow;
  principals: PrincipalRow;
  workspaces: WorkspaceRow;
  agents: AgentRow;
  capability_revisions: CapabilityRevisionRow;
  previews: PreviewRow;
  tasks: TaskRow;
  mandates: MandateRow;
  attempts: AttemptRow;
  events: EventRow;
  effects: EffectRow;
  inputs: InputRow;
  approvals: ApprovalRow;
  artifacts: ArtifactRow;
  attention: AttentionRow;
}

export const TABLE_NAMES = Object.freeze([
  "schema_meta",
  "principals",
  "workspaces",
  "agents",
  "capability_revisions",
  "previews",
  "tasks",
  "mandates",
  "attempts",
  "events",
  "effects",
  "inputs",
  "approvals",
  "artifacts",
  "attention",
] as const);

export type TableName = (typeof TABLE_NAMES)[number];

type AssertTableMapMatchesList = TableName extends keyof TableRowMap
  ? keyof TableRowMap extends TableName
    ? true
    : never
  : never;
const _tableMapMatchesList: AssertTableMapMatchesList = true;
void _tableMapMatchesList;

const TABLE_NAME_SET: ReadonlySet<string> = new Set(TABLE_NAMES);

export function isTableName(name: unknown): name is TableName {
  return typeof name === "string" && TABLE_NAME_SET.has(name);
}

export function assertTableName(name: unknown): TableName {
  if (!isTableName(name)) {
    throw validationFailed(`unknown task store table: "${String(name)}"`, { table: name });
  }
  return name;
}

/** Exhaustive primary-key column lookup across all 15 §5.1 tables. */
export function primaryKeyForTable(table: TableName): string {
  switch (table) {
    case "schema_meta":
      return "version";
    case "principals":
      return "principal_id";
    case "workspaces":
      return "workspace_id";
    case "agents":
      return "agent_id";
    case "capability_revisions":
      return "revision_id";
    case "previews":
      return "preview_id";
    case "tasks":
      return "task_id";
    case "mandates":
      return "mandate_id";
    case "attempts":
      return "attempt_id";
    case "events":
      return "event_id";
    case "effects":
      return "operation_id";
    case "inputs":
      return "input_id";
    case "approvals":
      return "approval_id";
    case "artifacts":
      return "artifact_id";
    case "attention":
      return "question_id";
    default: {
      const _exhaustive: never = table;
      throw validationFailed(`unknown task store table: "${String(_exhaustive)}"`, { table: _exhaustive });
    }
  }
}

export interface SchemaMetaProjection {
  version: number;
  updatedAt: string;
}

export interface PrincipalProjection {
  principalId: string;
  kind: string;
  scopes: unknown[];
  credentialHash: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceProjection {
  workspaceId: string;
  rootPath: string;
  allowedSideEffects: unknown[];
  policy: Record<string, unknown>;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProjection {
  agentId: string;
  adapterKind: string;
  adapterConfigRef: string;
  adapterConfig: Record<string, unknown>;
  manifestRevision: string;
  capabilities: Record<string, unknown>;
  probeStatus: string;
  probeEvidence: Record<string, unknown> | null;
  probeExpiresAt: string | null;
  enabled: boolean;
  updatedAt: string;
}

export interface CapabilityRevisionProjection {
  revisionId: string;
  capability: string;
  version: string;
  schema: Record<string, unknown>;
  sideEffectKind: string;
  cancelPolicy: string;
  limitations: unknown[];
  createdAt: string;
}

export interface PreviewProjection {
  previewId: string;
  principalId: string;
  normalizedRequest: Record<string, unknown>;
  candidates: unknown[];
  selectedAgentId: string | null;
  selectionReason: string | null;
  policyRevision: string | null;
  capabilityRevisionId: string | null;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface TaskProjection {
  taskId: string;
  principalId: string;
  idempotencyKey: string;
  requestHash: string;
  capabilityRevisionId: string;
  workspaceId: string;
  agentId: string;
  previewId: string | null;
  requestSummary: Record<string, unknown>;
  status: TaskStatus;
  stateVersion: number;
  activeAttemptId: string | null;
  cancelRequestedAt: string | null;
  cancelReason: string | null;
  sourceTaskId: string | null;
  result: unknown;
  resultValid: boolean | null;
  error: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface MandateProjection {
  mandateId: string;
  principalId: string;
  taskId: string;
  workspaceId: string;
  agentId: string;
  allowedOps: unknown[];
  policyRevision: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface AttemptProjection {
  attemptId: string;
  taskId: string;
  attemptNo: number;
  agentId: string;
  mandateId: string | null;
  capabilityRevisionId: string;
  runtimeLocator: Record<string, unknown> | null;
  status: string;
  failureClass: string | null;
  sideEffectActive: boolean;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface EventProjection {
  eventId: string;
  taskId: string;
  seq: number;
  attemptId: string | null;
  type: string;
  source: string;
  adapterEventId: string | null;
  payload: Record<string, unknown>;
  evidence: unknown;
  createdAt: string;
}

export interface EffectProjection {
  operationId: string;
  taskId: string;
  attemptId: string | null;
  opType: string;
  idempotencyKey: string | null;
  requestSummary: Record<string, unknown>;
  status: string;
  leaseExpiresAt: string | null;
  receipt: unknown;
  reconcileResult: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface InputProjection {
  inputId: string;
  taskId: string;
  attemptId: string;
  questionId: string | null;
  idempotencyKey: string;
  text: string;
  deliveryStatus: string;
  evidence: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalProjection {
  approvalId: string;
  taskId: string;
  attemptId: string;
  scope: Record<string, unknown>;
  summary: string;
  status: string;
  decision: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  idempotencyKey: string | null;
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface ArtifactProjection {
  artifactId: string;
  taskId: string;
  attemptId: string | null;
  kind: string;
  sizeBytes: number;
  sha256: string | null;
  sourcePath: string | null;
  accessPolicy: Record<string, unknown>;
  createdAt: string;
}

export interface AttentionProjection {
  questionId: string;
  taskId: string;
  attemptId: string | null;
  kind: AttentionKind;
  prompt: string;
  options: unknown[];
  status: string;
  expiresAt: string | null;
  resolvedBy: string | null;
  resolution: unknown;
  createdAt: string;
  resolvedAt: string | null;
}

function parseJsonColumn<T>(text: string | null | undefined, fallback: T): T {
  if (typeof text !== "string" || text.length === 0) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function rowToSchemaMeta(row: SchemaMetaRow): SchemaMetaProjection {
  return {
    version: row.version,
    updatedAt: row.updated_at,
  };
}

export function rowToPrincipal(row: PrincipalRow): PrincipalProjection {
  return {
    principalId: row.principal_id,
    kind: row.kind,
    scopes: parseJsonColumn<unknown[]>(row.scopes_json, []),
    credentialHash: row.credential_hash ?? null,
    revokedAt: row.revoked_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToWorkspace(row: WorkspaceRow): WorkspaceProjection {
  return {
    workspaceId: row.workspace_id,
    rootPath: row.root_path,
    allowedSideEffects: parseJsonColumn<unknown[]>(row.allowed_side_effects_json, []),
    policy: parseJsonColumn<Record<string, unknown>>(row.policy_json, {}),
    revokedAt: row.revoked_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToAgent(row: AgentRow): AgentProjection {
  return {
    agentId: row.agent_id,
    adapterKind: row.adapter_kind,
    adapterConfigRef: row.adapter_config_ref,
    adapterConfig: parseJsonColumn<Record<string, unknown>>(row.adapter_config_ref, {}),
    manifestRevision: row.manifest_revision,
    capabilities: parseJsonColumn<Record<string, unknown>>(row.capabilities_json, {}),
    probeStatus: row.probe_status,
    probeEvidence: parseJsonColumn<Record<string, unknown> | null>(row.probe_evidence_json, null),
    probeExpiresAt: row.probe_expires_at ?? null,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  };
}

export function rowToCapabilityRevision(row: CapabilityRevisionRow): CapabilityRevisionProjection {
  return {
    revisionId: row.revision_id,
    capability: row.capability,
    version: row.version,
    schema: parseJsonColumn<Record<string, unknown>>(row.schema_json, {}),
    sideEffectKind: row.side_effect_kind,
    cancelPolicy: row.cancel_policy,
    limitations: parseJsonColumn<unknown[]>(row.limitations_json, []),
    createdAt: row.created_at,
  };
}

export function rowToPreview(row: PreviewRow): PreviewProjection {
  return {
    previewId: row.preview_id,
    principalId: row.principal_id,
    normalizedRequest: parseJsonColumn<Record<string, unknown>>(row.normalized_request_json, {}),
    candidates: parseJsonColumn<unknown[]>(row.candidates_json, []),
    selectedAgentId: row.selected_agent_id ?? null,
    selectionReason: row.selection_reason ?? null,
    policyRevision: row.policy_revision ?? null,
    capabilityRevisionId: row.capability_revision_id ?? null,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at ?? null,
    createdAt: row.created_at,
  };
}

export function rowToTask(row: TaskRow): TaskProjection {
  return {
    taskId: row.task_id,
    principalId: row.principal_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    capabilityRevisionId: row.capability_revision_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    previewId: row.preview_id ?? null,
    requestSummary: parseJsonColumn<Record<string, unknown>>(row.request_summary_json, {}),
    status: row.status,
    stateVersion: row.state_version,
    activeAttemptId: row.active_attempt_id ?? null,
    cancelRequestedAt: row.cancel_requested_at ?? null,
    cancelReason: row.cancel_reason ?? null,
    sourceTaskId: row.source_task_id ?? null,
    result: row.result_json ? parseJsonColumn<unknown>(row.result_json, null) : null,
    resultValid: row.result_valid === null ? null : row.result_valid === 1,
    error: row.error_json ? parseJsonColumn<unknown>(row.error_json, null) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}

export function rowToMandate(row: MandateRow): MandateProjection {
  return {
    mandateId: row.mandate_id,
    principalId: row.principal_id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    allowedOps: parseJsonColumn<unknown[]>(row.allowed_ops_json, []),
    policyRevision: row.policy_revision,
    expiresAt: row.expires_at ?? null,
    revokedAt: row.revoked_at ?? null,
    createdAt: row.created_at,
  };
}

export function rowToAttempt(row: AttemptRow): AttemptProjection {
  return {
    attemptId: row.attempt_id,
    taskId: row.task_id,
    attemptNo: row.attempt_no,
    agentId: row.agent_id,
    mandateId: row.mandate_id ?? null,
    capabilityRevisionId: row.capability_revision_id,
    runtimeLocator: parseJsonColumn<Record<string, unknown> | null>(row.runtime_locator_json, null),
    status: row.status,
    failureClass: row.failure_class ?? null,
    sideEffectActive: row.side_effect_active === 1,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at ?? null,
  };
}

export function rowToEvent(row: EventRow): EventProjection {
  return {
    eventId: row.event_id,
    taskId: row.task_id,
    seq: row.seq,
    attemptId: row.attempt_id ?? null,
    type: row.type,
    source: row.source,
    adapterEventId: row.adapter_event_id ?? null,
    payload: parseJsonColumn<Record<string, unknown>>(row.payload_json, {}),
    evidence: parseJsonColumn<unknown>(row.evidence_json, null),
    createdAt: row.created_at,
  };
}

export function rowToEffect(row: EffectRow): EffectProjection {
  return {
    operationId: row.operation_id,
    taskId: row.task_id,
    attemptId: row.attempt_id ?? null,
    opType: row.op_type,
    idempotencyKey: row.idempotency_key ?? null,
    requestSummary: parseJsonColumn<Record<string, unknown>>(row.request_summary_json, {}),
    status: row.status,
    leaseExpiresAt: row.lease_expires_at ?? null,
    receipt: parseJsonColumn<unknown>(row.receipt_json, null),
    reconcileResult: parseJsonColumn<unknown>(row.reconcile_result_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToInput(row: InputRow): InputProjection {
  return {
    inputId: row.input_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    questionId: row.question_id ?? null,
    idempotencyKey: row.idempotency_key,
    text: row.text,
    deliveryStatus: row.delivery_status,
    evidence: parseJsonColumn<unknown>(row.evidence_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToApproval(row: ApprovalRow): ApprovalProjection {
  return {
    approvalId: row.approval_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    scope: parseJsonColumn<Record<string, unknown>>(row.scope_json, {}),
    summary: row.summary,
    status: row.status,
    decision: row.decision ?? null,
    decidedBy: row.decided_by ?? null,
    decisionNote: row.decision_note ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? null,
  };
}

export function rowToArtifact(row: ArtifactRow): ArtifactProjection {
  return {
    artifactId: row.artifact_id,
    taskId: row.task_id,
    attemptId: row.attempt_id ?? null,
    kind: row.kind,
    sizeBytes: row.size_bytes,
    sha256: row.sha256 ?? null,
    sourcePath: row.source_path ?? null,
    accessPolicy: parseJsonColumn<Record<string, unknown>>(row.access_policy_json, {}),
    createdAt: row.created_at,
  };
}

export function rowToAttention(row: AttentionRow): AttentionProjection {
  return {
    questionId: row.question_id,
    taskId: row.task_id,
    attemptId: row.attempt_id ?? null,
    kind: row.kind,
    prompt: row.prompt,
    options: parseJsonColumn<unknown[]>(row.options_json, []),
    status: row.status,
    expiresAt: row.expires_at ?? null,
    resolvedBy: row.resolved_by ?? null,
    resolution: parseJsonColumn<unknown>(row.resolution_json, null),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
  };
}

export interface OpenStoreOptions {
  path?: string;
  readonly?: boolean;
  busyTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface TaskStore {
  readonly path: string;
  readonly readonly: boolean;
  readonly db: DatabaseSync;
  readonly closed: boolean;
  read<T>(fn: (db: DatabaseSync) => T): T;
  withWriteTx<T>(fn: (db: DatabaseSync) => T): Promise<T>;
  close(): void;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER PRIMARY KEY,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS principals (
  principal_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  credential_hash TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  allowed_side_effects_json TEXT NOT NULL DEFAULT '[]',
  policy_json TEXT NOT NULL DEFAULT '{}',
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  adapter_kind TEXT NOT NULL,
  adapter_config_ref TEXT NOT NULL DEFAULT '',
  manifest_revision TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  probe_status TEXT NOT NULL DEFAULT 'unknown',
  probe_evidence_json TEXT,
  probe_expires_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capability_revisions (
  revision_id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  version TEXT NOT NULL,
  schema_json TEXT NOT NULL DEFAULT '{}',
  side_effect_kind TEXT NOT NULL DEFAULT 'read',
  cancel_policy TEXT NOT NULL DEFAULT 'required',
  limitations_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS previews (
  preview_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  normalized_request_json TEXT NOT NULL,
  candidates_json TEXT NOT NULL DEFAULT '[]',
  selected_agent_id TEXT REFERENCES agents(agent_id),
  selection_reason TEXT,
  policy_revision TEXT,
  capability_revision_id TEXT REFERENCES capability_revisions(revision_id),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  capability_revision_id TEXT NOT NULL REFERENCES capability_revisions(revision_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  preview_id TEXT REFERENCES previews(preview_id),
  request_summary_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 1,
  active_attempt_id TEXT,
  cancel_requested_at TEXT,
  cancel_reason TEXT,
  source_task_id TEXT REFERENCES tasks(task_id),
  result_json TEXT,
  result_valid INTEGER,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(principal_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at, task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_principal ON tasks(principal_id, updated_at, task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id, updated_at, task_id);

CREATE TABLE IF NOT EXISTS mandates (
  mandate_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  allowed_ops_json TEXT NOT NULL DEFAULT '[]',
  policy_revision TEXT NOT NULL DEFAULT 'v1',
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_no INTEGER NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  mandate_id TEXT REFERENCES mandates(mandate_id),
  capability_revision_id TEXT NOT NULL REFERENCES capability_revisions(revision_id),
  runtime_locator_json TEXT,
  status TEXT NOT NULL,
  failure_class TEXT,
  side_effect_active INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(task_id, attempt_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_one_active
  ON attempts(task_id)
  WHERE side_effect_active = 1;

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  seq INTEGER NOT NULL,
  attempt_id TEXT REFERENCES attempts(attempt_id),
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  adapter_event_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_adapter_dedup
  ON events(task_id, attempt_id, adapter_event_id)
  WHERE adapter_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS effects (
  operation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT REFERENCES attempts(attempt_id),
  op_type TEXT NOT NULL,
  idempotency_key TEXT,
  request_summary_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  lease_expires_at TEXT,
  receipt_json TEXT,
  reconcile_result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_effects_task_op_idem
  ON effects(task_id, op_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS inputs (
  input_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  question_id TEXT,
  idempotency_key TEXT NOT NULL,
  text TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  scope_json TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  decision TEXT,
  decided_by TEXT,
  decision_note TEXT,
  idempotency_key TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT REFERENCES attempts(attempt_id),
  kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  source_path TEXT,
  access_policy_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attention (
  question_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT REFERENCES attempts(attempt_id),
  kind TEXT NOT NULL CHECK(kind IN ('decision', 'input', 'approval', 'review')),
  prompt TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  expires_at TEXT,
  resolved_by TEXT,
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_attention_task_status ON attention(task_id, status);
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { errcode?: unknown; message?: unknown };
  if (candidate.errcode === 5 || candidate.errcode === 6) return true;
  const msg = String(candidate.message ?? "");
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED|database table is locked/i.test(msg);
}

/**
 * Open a SQLite task store.
 */
export function openStore({
  path = ":memory:",
  readonly = false,
  busyTimeoutMs = 200,
  maxRetries = 12,
  retryDelayMs = 10,
}: OpenStoreOptions = {}): TaskStore {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw validationFailed("`path` must be a non-empty string or ':memory:'");
  }
  const dbPath = path.trim();
  if (!readonly && dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath, { readOnly: Boolean(readonly) });
  let closed = false;
  let txChain: Promise<void> = Promise.resolve();

  const ensureOpen = (): void => {
    if (closed) throw taskError(TASK_ERROR.STATE_CONFLICT, "task store is closed");
  };

  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))};`);
    db.exec("PRAGMA foreign_keys = ON;");

    if (!readonly) {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec(SCHEMA_SQL);
      const existingMeta = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
        | Pick<SchemaMetaRow, "version">
        | undefined;
      if (!existingMeta) {
        db.prepare("INSERT INTO schema_meta (version, updated_at) VALUES (?, ?)").run(
          SCHEMA_VERSION,
          new Date().toISOString(),
        );
      } else if (existingMeta.version !== SCHEMA_VERSION) {
        throw taskError(
          TASK_ERROR.STATE_CONFLICT,
          `unsupported schema version ${existingMeta.version}; expected ${SCHEMA_VERSION}`,
          { foundVersion: existingMeta.version, expectedVersion: SCHEMA_VERSION },
        );
      }
    } else {
      const meta = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
        | Pick<SchemaMetaRow, "version">
        | undefined;
      if (meta && meta.version !== SCHEMA_VERSION) {
        throw taskError(
          TASK_ERROR.STATE_CONFLICT,
          `unsupported schema version ${meta.version}; expected ${SCHEMA_VERSION}`,
          { foundVersion: meta.version, expectedVersion: SCHEMA_VERSION },
        );
      }
    }
  } catch (err) {
    try {
      db.close();
    } catch {
      // best effort
    }
    throw err;
  }

  const runImmediateAttempt = <T,>(fn: (db: DatabaseSync) => T): T => {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn(db);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("withWriteTx callback must be synchronous");
      }
      db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // ROLLBACK can fail if SQLite already auto-rolled back
      }
      throw error;
    }
  };

  return {
    path: dbPath,
    readonly: Boolean(readonly),
    db,

    get closed(): boolean {
      return closed;
    },

    /** Execute a synchronous read callback against the store. */
    read<T>(fn: (db: DatabaseSync) => T): T {
      ensureOpen();
      return fn(db);
    },

    /**
     * Execute a synchronous write callback inside `BEGIN IMMEDIATE` ... `COMMIT`.
     * Calls on the same store handle serialize cleanly, and cross-connection
     * `SQLITE_BUSY` contention retries with jittered backoff.
     */
    withWriteTx<T>(fn: (db: DatabaseSync) => T): Promise<T> {
      ensureOpen();
      if (readonly) {
        return Promise.reject(taskError(TASK_ERROR.ACCESS_DENIED, "cannot write to a readonly task store"));
      }
      if (typeof fn !== "function") {
        return Promise.reject(validationFailed("withWriteTx expects a function"));
      }

      const task = txChain.then(async () => {
        ensureOpen();
        let attempt = 0;
        while (true) {
          try {
            return runImmediateAttempt(fn);
          } catch (error) {
            if (!isSqliteBusyError(error) || attempt >= maxRetries) {
              throw error;
            }
            attempt += 1;
            const jitter = Math.floor(Math.random() * retryDelayMs);
            await sleep(retryDelayMs * attempt + jitter);
          }
        }
      });

      txChain = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },

    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
