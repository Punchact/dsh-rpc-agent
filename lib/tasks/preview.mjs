// One-shot preview creation and consumption (§5.1 & §6.1).
// Previews bind a normalized request digest, selected agent, workspace, and
// capability revision for a bounded TTL, and can be consumed at most once.

import { randomUUID } from "node:crypto";

import { TASK_ERROR, notFoundError, taskError, validationFailed } from "./errors.mjs";

const DEFAULT_PREVIEW_TTL_MS = 300_000;

function parseJson(text, fallback = null) {
  if (typeof text !== "string" || text.length === 0) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationFailed(`\`${field}\` must be a non-empty string`, { field });
  }
  return value.trim();
}

export function createPreviewInTx(
  db,
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
  },
) {
  const pid = requireNonEmptyString(principalId, "principalId");
  const digest = requireNonEmptyString(requestDigest, "requestDigest");
  const capRevId = requireNonEmptyString(capabilityRevisionId, "capabilityRevisionId");
  const wsId = requireNonEmptyString(workspaceId, "workspaceId");
  const agId = requireNonEmptyString(agentId, "agentId");

  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw validationFailed("`ttlMs` must be a positive integer", { field: "ttlMs", ttlMs });
  }

  const principal = db.prepare("SELECT principal_id, revoked_at FROM principals WHERE principal_id = ?").get(pid);
  if (!principal) throw notFoundError(`principal not found: ${pid}`, { principalId: pid });
  if (principal.revoked_at) throw taskError(TASK_ERROR.ACCESS_DENIED, `principal "${pid}" is revoked`, { principalId: pid });

  const workspace = db.prepare("SELECT workspace_id, revoked_at FROM workspaces WHERE workspace_id = ?").get(wsId);
  if (!workspace) throw notFoundError(`workspace not found: ${wsId}`, { workspaceId: wsId });
  if (workspace.revoked_at) throw taskError(TASK_ERROR.ACCESS_DENIED, `workspace "${wsId}" is revoked`, { workspaceId: wsId });

  const agent = db.prepare("SELECT agent_id, enabled FROM agents WHERE agent_id = ?").get(agId);
  if (!agent) throw notFoundError(`agent not found: ${agId}`, { agentId: agId });
  if (agent.enabled !== 1) throw validationFailed(`agent "${agId}" is disabled`, { agentId: agId });

  const capRev = db.prepare("SELECT revision_id FROM capability_revisions WHERE revision_id = ?").get(capRevId);
  if (!capRev) throw notFoundError(`capability revision not found: ${capRevId}`, { capabilityRevisionId: capRevId });

  const nowMs = now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const previewId = `pv_${randomUUID()}`;

  const storedNormalized = {
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
    JSON.stringify(Array.isArray(candidates) ? candidates : []),
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
    expiresAt,
    createdAt,
  };
}

export async function createPreview(store, params) {
  return store.withWriteTx((db) => createPreviewInTx(db, params));
}

export function consumePreviewInTx(db, { previewId, principalId, requestDigest, now = Date.now }) {
  const pvId = requireNonEmptyString(previewId, "previewId");
  const pid = requireNonEmptyString(principalId, "principalId");

  const preview = db.prepare("SELECT * FROM previews WHERE preview_id = ?").get(pvId);
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

  const norm = parseJson(preview.normalized_request_json, {});
  const storedDigest = norm?.requestDigest ?? null;
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
    workspaceId: norm?.workspaceId ?? null,
    agentId: preview.selected_agent_id,
    capabilityRevisionId: preview.capability_revision_id,
    normalizedRequest: norm,
    expiresAt: preview.expires_at,
    consumedAt,
  };
}

export async function consumePreview(store, params) {
  return store.withWriteTx((db) => consumePreviewInTx(db, params));
}
