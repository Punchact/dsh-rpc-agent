// One-shot preview creation and consumption (§5.1 & §6.1).
// Previews bind a normalized request digest, selected agent, workspace, and
// capability revision for a bounded TTL, and can be consumed at most once.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { degradedFromCapabilities, type DegradedControlEntry } from "./degraded.mjs";
import { TASK_ERROR, notFoundError, taskError, validationFailed } from "./errors.mjs";
import type {
  AgentRow,
  CapabilityRevisionRow,
  PreviewRow,
  PrincipalRow,
  TaskStore,
  WorkspaceRow,
} from "./store.mjs";

const DEFAULT_PREVIEW_TTL_MS = 300_000;

export interface PreviewExclusionCandidate {
  agentId: string;
  included: boolean;
  reason: string;
  capabilityRevisionId?: string;
  [key: string]: unknown;
}

export interface CreatePreviewParams {
  principalId: string;
  requestDigest: string;
  capabilityRevisionId: string;
  workspaceId: string;
  agentId: string;
  ttlMs?: number;
  normalizedRequest?: Record<string, unknown>;
  candidates?: PreviewExclusionCandidate[];
  selectionReason?: string;
  policyRevision?: string;
  now?: () => number;
}

export interface CreatePreviewResult {
  previewId: string;
  principalId: string;
  requestDigest: string;
  capabilityRevisionId: string;
  workspaceId: string;
  agentId: string;
  candidates: PreviewExclusionCandidate[];
  selectionReason: string;
  degraded: DegradedControlEntry[];
  expiresAt: string;
  createdAt: string;
}

export interface ConsumePreviewParams {
  previewId: string;
  principalId: string;
  requestDigest?: string | null | undefined;
  now?: () => number;
}

export interface ConsumePreviewResult {
  previewId: string;
  principalId: string;
  requestDigest: string | null;
  workspaceId: string | null;
  agentId: string | null;
  capabilityRevisionId: string | null;
  normalizedRequest: Record<string, unknown>;
  expiresAt: string;
  consumedAt: string;
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (typeof text !== "string" || text.length === 0) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationFailed(`\`${field}\` must be a non-empty string`, { field });
  }
  return value.trim();
}

export function createPreviewInTx(
  db: DatabaseSync,
  {
    principalId,
    requestDigest,
    capabilityRevisionId,
    workspaceId,
    agentId,
    ttlMs = DEFAULT_PREVIEW_TTL_MS,
    normalizedRequest = {},
    candidates = [],
    selectionReason = "selected",
    policyRevision = "v1",
    now = Date.now,
  }: CreatePreviewParams,
): CreatePreviewResult {
  const pid = requireNonEmptyString(principalId, "principalId");
  const digest = requireNonEmptyString(requestDigest, "requestDigest");
  const capRevId = requireNonEmptyString(capabilityRevisionId, "capabilityRevisionId");
  const wsId = requireNonEmptyString(workspaceId, "workspaceId");
  const agId = requireNonEmptyString(agentId, "agentId");

  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw validationFailed("`ttlMs` must be a positive integer", { field: "ttlMs", ttlMs });
  }

  const principal = db
    .prepare("SELECT principal_id, revoked_at FROM principals WHERE principal_id = ?")
    .get(pid) as Pick<PrincipalRow, "principal_id" | "revoked_at"> | undefined;
  if (!principal) throw notFoundError(`principal not found: ${pid}`, { principalId: pid });
  if (principal.revoked_at) {
    throw taskError(TASK_ERROR.ACCESS_DENIED, `principal "${pid}" is revoked`, { principalId: pid });
  }

  const workspace = db
    .prepare("SELECT workspace_id, revoked_at FROM workspaces WHERE workspace_id = ?")
    .get(wsId) as Pick<WorkspaceRow, "workspace_id" | "revoked_at"> | undefined;
  if (!workspace) throw notFoundError(`workspace not found: ${wsId}`, { workspaceId: wsId });
  if (workspace.revoked_at) {
    throw taskError(TASK_ERROR.ACCESS_DENIED, `workspace "${wsId}" is revoked`, { workspaceId: wsId });
  }

  const agent = db
    .prepare(
      "SELECT agent_id, enabled, capabilities_json, probe_status, probe_expires_at FROM agents WHERE agent_id = ?",
    )
    .get(agId) as
    | Pick<AgentRow, "agent_id" | "enabled" | "capabilities_json" | "probe_status" | "probe_expires_at">
    | undefined;
  if (!agent) throw notFoundError(`agent not found: ${agId}`, { agentId: agId });
  if (agent.enabled !== 1) throw validationFailed(`agent "${agId}" is disabled`, { agentId: agId });

  const capRev = db
    .prepare("SELECT revision_id, capability, version FROM capability_revisions WHERE revision_id = ?")
    .get(capRevId) as Pick<CapabilityRevisionRow, "revision_id" | "capability" | "version"> | undefined;
  if (!capRev) {
    throw notFoundError(`capability revision not found: ${capRevId}`, { capabilityRevisionId: capRevId });
  }

  const nowMs = now();

  const declaredRevisionsOf = (
    row: Pick<AgentRow, "capabilities_json"> | null | undefined,
  ): Array<{ revisionId?: string; capabilityId?: string }> => {
    try {
      const parsed = typeof row?.capabilities_json === "string" ? JSON.parse(row.capabilities_json) : {};
      return Array.isArray(parsed?.capabilityRevisions) ? parsed.capabilityRevisions : [];
    } catch {
      return [];
    }
  };

  // §4.4 step 1: a revision that the selected agent never declared cannot be
  // executed by it, so the preview must fail loudly instead of booking the task.
  const declaredHere = declaredRevisionsOf(agent).find((item) => item.revisionId === capRevId);
  if (!declaredHere) {
    throw validationFailed(
      `agent "${agId}" does not declare capability revision "${capRevId}"`,
      { field: "capabilityRevisionId", reason: "CAPABILITY_VERSION_MISSING", agentId: agId },
    );
  }

  // A probe result that has expired is not evidence of anything any more.
  const probeExpiresAt = agent.probe_expires_at ? Date.parse(agent.probe_expires_at) : null;
  if (probeExpiresAt !== null && Number.isFinite(probeExpiresAt) && probeExpiresAt <= nowMs) {
    throw validationFailed(
      `probe evidence for agent "${agId}" expired at ${agent.probe_expires_at}`,
      { field: "agentId", reason: "PROBE_STALE", agentId: agId },
    );
  }
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const previewId = `pv_${randomUUID()}`;

  // §4.4: report why the other instances that declare the same capability are not
  // candidates, so the caller can see the routing decision instead of guessing.
  const exclusions: PreviewExclusionCandidate[] = [];
  const peers = db
    .prepare("SELECT agent_id, enabled, capabilities_json, probe_expires_at FROM agents ORDER BY agent_id ASC")
    .all() as unknown as Array<Pick<AgentRow, "agent_id" | "enabled" | "capabilities_json" | "probe_expires_at">>;
  for (const row of peers) {
    if (row.agent_id === agId) continue;
    const declared = declaredRevisionsOf(row).find((item) => item.capabilityId === capRev.capability);
    if (!declared) continue;
    const peerProbeExpiry = row.probe_expires_at ? Date.parse(row.probe_expires_at) : null;
    let reason: string | null = null;
    if (row.enabled !== 1) reason = "AGENT_DISABLED";
    else if (peerProbeExpiry !== null && Number.isFinite(peerProbeExpiry) && peerProbeExpiry <= nowMs) {
      reason = "PROBE_STALE";
    }
    if (reason) exclusions.push({ agentId: row.agent_id, included: false, reason });
  }
  const candidateList: PreviewExclusionCandidate[] = [
    ...exclusions,
    ...(Array.isArray(candidates) ? candidates : []),
    { agentId: agId, included: true, reason: "SELECTED", capabilityRevisionId: capRevId },
  ];

  const storedNormalized: Record<string, unknown> = {
    ...(normalizedRequest && typeof normalizedRequest === "object" && !Array.isArray(normalizedRequest)
      ? normalizedRequest
      : {}),
    workspaceId: wsId,
    requestDigest: digest,
  };

  db.prepare(
    `INSERT INTO previews (
       preview_id, principal_id, normalized_request_json, candidates_json,
       selected_agent_id, selection_reason, policy_revision, capability_revision_id,
       expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    previewId,
    pid,
    JSON.stringify(storedNormalized),
    JSON.stringify(candidateList),
    agId,
    typeof selectionReason === "string" ? selectionReason : "selected",
    typeof policyRevision === "string" ? policyRevision : "v1",
    capRevId,
    expiresAt,
    createdAt,
  );

  return {
    previewId,
    principalId: pid,
    requestDigest: digest,
    capabilityRevisionId: capRevId,
    workspaceId: wsId,
    agentId: agId,
    candidates: candidateList,
    selectionReason: typeof selectionReason === "string" ? selectionReason : "selected",
    degraded: degradedFromCapabilities(agent?.capabilities_json),
    expiresAt,
    createdAt,
  };
}

export async function createPreview(store: TaskStore, params: CreatePreviewParams): Promise<CreatePreviewResult> {
  return store.withWriteTx((db) => createPreviewInTx(db, params));
}

export function consumePreviewInTx(
  db: DatabaseSync,
  { previewId, principalId, requestDigest, now = Date.now }: ConsumePreviewParams,
): ConsumePreviewResult {
  const pvId = requireNonEmptyString(previewId, "previewId");
  const pid = requireNonEmptyString(principalId, "principalId");

  const preview = db.prepare("SELECT * FROM previews WHERE preview_id = ?").get(pvId) as PreviewRow | undefined;
  if (!preview || preview.principal_id !== pid) {
    // Consistent lookup failure avoids leaking existence across principals (§6.1).
    throw notFoundError(`preview not found: ${pvId}`, { previewId: pvId });
  }

  if (preview.consumed_at !== null) {
    throw taskError(TASK_ERROR.PREVIEW_EXPIRED, `preview "${pvId}" has already been consumed`, {
      previewId: pvId,
      consumedAt: preview.consumed_at,
    });
  }

  const nowMs = now();
  if (Date.parse(preview.expires_at) <= nowMs) {
    throw taskError(TASK_ERROR.PREVIEW_EXPIRED, `preview "${pvId}" has expired`, {
      previewId: pvId,
      expiresAt: preview.expires_at,
    });
  }

  const norm = parseJson<Record<string, unknown>>(preview.normalized_request_json, {});
  const storedDigest = typeof norm?.requestDigest === "string" ? norm.requestDigest : null;
  if (requestDigest !== undefined && requestDigest !== null) {
    const provided = requireNonEmptyString(requestDigest, "requestDigest");
    if (storedDigest !== provided) {
      throw taskError(TASK_ERROR.PREVIEW_MISMATCH, `preview "${pvId}" requestDigest mismatch`, {
        previewId: pvId,
      });
    }
  }

  const consumedAt = new Date(nowMs).toISOString();
  const res = db
    .prepare("UPDATE previews SET consumed_at = ? WHERE preview_id = ? AND consumed_at IS NULL")
    .run(consumedAt, pvId);
  if (res.changes !== 1) {
    throw taskError(TASK_ERROR.PREVIEW_EXPIRED, `preview "${pvId}" has already been consumed`, {
      previewId: pvId,
    });
  }

  return {
    previewId: pvId,
    principalId: pid,
    requestDigest: storedDigest,
    workspaceId: typeof norm?.workspaceId === "string" ? norm.workspaceId : null,
    agentId: preview.selected_agent_id,
    capabilityRevisionId: preview.capability_revision_id,
    normalizedRequest: norm,
    expiresAt: preview.expires_at,
    consumedAt,
  };
}

export async function consumePreview(store: TaskStore, params: ConsumePreviewParams): Promise<ConsumePreviewResult> {
  return store.withWriteTx((db) => consumePreviewInTx(db, params));
}
