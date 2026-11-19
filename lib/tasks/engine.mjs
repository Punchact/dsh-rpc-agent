// Task-center engine (§5): idempotent submission, durable cancel registration,
// report-to-state-machine mapping (§5.3), derived phase projection (§5.4),
// approval decisions, and human resolution. Contains zero adapter calls.

import { createHash, randomUUID } from "node:crypto";
import { redactSecrets } from "../adapters/redact.mjs";
import { degradedFromCapabilities } from "./degraded.mjs";

import {
  TASK_ERROR,
  accessDeniedError,
  cursorExpired,
  idempotencyConflict,
  notFoundError,
  stateConflict,
  taskError,
  validationFailed,
} from "./errors.mjs";
import { artifactIdFor, readArtifactWindow, verifyArtifactClaim } from "./artifacts.mjs";
import { consumePreviewInTx } from "./preview.mjs";
import { TERMINAL_STATES, appendEventInTx, transitionInTx } from "./state-machine.mjs";

const REPORT_STATES = new Set(["progress", "waiting", "ready", "blocked", "failed", "dropped"]);
const ATTENTION_KINDS = new Set(["decision", "input", "approval", "review"]);

const PHASE_LABELS = Object.freeze({
  "person/delivery": "Input undelivered",
  "person/approval": "Awaiting approval",
  "person/answer": "Awaiting answer",
  "person/reconcile": "Needs reconciliation",
  "person/review": "Awaiting review",
  "machine/queued": "Queued",
  "machine/working": "Working",
  done: "Finished",
});

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

function hashRequest(payload) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function parseJson(text, fallback = null) {
  if (typeof text !== "string" || text.length === 0) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function requireNonEmptyString(value, key) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationFailed(`\`${key}\` must be a non-empty string`, { field: key });
  }
  return value.trim();
}

function encodeCursor({ updatedAt, taskId }) {
  return Buffer.from(JSON.stringify({ updatedAt, taskId }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  if (typeof cursor !== "string" || cursor.trim().length === 0) {
    throw validationFailed("`cursor` must be a non-empty string", { field: "cursor" });
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.updatedAt !== "string" || typeof parsed.taskId !== "string") {
      throw new Error("missing fields");
    }
    return parsed;
  } catch {
    throw validationFailed("invalid pagination cursor", { field: "cursor" });
  }
}

function isAttentionOpen(row) {
  if (!row || typeof row !== "object") return false;
  if (row.status !== undefined) return row.status === "open";
  return !row.resolved_at && !row.resolvedAt;
}

/**
 * Pure derived-phase function (§5.4): "phase = who are we waiting on?"
 * Evaluated top-to-bottom; first matching rule wins. Never persisted.
 *
 * @param {object} task Task projection (`status`, optional `undeliveredInputCount`, `leaseExpiresAt`, `reconcileLeaseExpired`)
 * @param {Array<object>} [attentionRows=[]] Attention rows for this task
 * @param {object|null} [lastEvent=null] Most recent event for this task
 * @param {object} [options={}] Optional `{ nowMs }` override for deterministic testing
 * @returns {{ phase: string, label: string }}
 */
export { degradedFromCapabilities } from "./degraded.mjs";

export function derivePhase(task, attentionRows = [], lastEvent = null, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const status = task?.status;
  const openAttention = Array.isArray(attentionRows) ? attentionRows.filter(isAttentionOpen) : [];

  // 1. person/delivery: undelivered input retrying
  const hasUndeliveredInput =
    (typeof task?.undeliveredInputCount === "number" && task.undeliveredInputCount > 0) ||
    task?.hasUndeliveredInput === true ||
    lastEvent?.type === "input.queued" ||
    lastEvent?.type === "input.retrying";
  if (hasUndeliveredInput && !TERMINAL_STATES.has(status)) {
    return { phase: "person/delivery", label: PHASE_LABELS["person/delivery"] };
  }

  // 2. person/approval: pending approval takes precedence over questions (§5.2 & §5.4)
  if (openAttention.some((row) => row.kind === "approval")) {
    return { phase: "person/approval", label: PHASE_LABELS["person/approval"] };
  }

  // 3. person/reconcile: needs_reconcile after lease expiry, or after a stop we could not
  //    confirm. This rung sits *above* the question rung on purpose: once the executor's own
  //    account of the stop is untrusted, answering its leftover question is not the operator's
  //    job — reconciling is. 0.9.0 live run: a `cancel.unconfirmed` task with an open `input`
  //    attention reported `person/answer`, hiding the reconcile duty behind a stale question.
  //    The condition is the status alone, never the event that produced it. 0.9.0 taught this
  //    twice: first a `cancel.unconfirmed` task with an open `input` attention reported
  //    `person/answer`, hiding the reconcile duty behind a stale question; then, after that was
  //    fixed by whitelisting four event names, `dispatch.failed` and `inspect.unknown` — both of
  //    which enter this state from `lib/tasks/dispatch.mjs` — were missing from the list and fell
  //    through to `machine/working`, i.e. “machine is still working” for a task only a person can
  //    move. Any enumeration of *why* we got here goes stale the next time a new reason appears;
  //    the state itself is the duty.
  if (status === "needs_reconcile") {
    return { phase: "person/reconcile", label: PHASE_LABELS["person/reconcile"] };
  }

  // 4. person/answer: pending decision or input question
  if (openAttention.some((row) => row.kind === "decision" || row.kind === "input")) {
    return { phase: "person/answer", label: PHASE_LABELS["person/answer"] };
  }

  // 5. person/review: review_pending or open review attention (e.g. report.invalid)
  if (status === "review_pending" || openAttention.some((row) => row.kind === "review")) {
    return { phase: "person/review", label: PHASE_LABELS["person/review"] };
  }

  // 6. machine/queued: queued or dispatching
  if (status === "queued" || status === "dispatching") {
    return { phase: "machine/queued", label: PHASE_LABELS["machine/queued"] };
  }

  // 8. done: terminal states. Checked before the machine/working fallback so a
  //    terminal row can never report `machine/working`; the plan numbers this rung 8.
  if (TERMINAL_STATES.has(status)) {
    return { phase: "done", label: PHASE_LABELS.done };
  }

  // 7. machine/working: active machine execution without open human attention
  //    (the fallback rung; `done` above is rung 8 and must be decided first)
  return { phase: "machine/working", label: PHASE_LABELS["machine/working"] };
}

function validateStructuredAttention(attention) {
  if (!attention || typeof attention !== "object" || Array.isArray(attention)) return false;
  if (!ATTENTION_KINDS.has(attention.kind)) return false;
  if (typeof attention.prompt !== "string" || attention.prompt.trim().length === 0) return false;
  if (attention.options !== undefined && !Array.isArray(attention.options)) return false;
  return true;
}

/**
 * §5.3 idempotency: a repeated report must not mint a second identical question. The same
 * open (task, kind, prompt) row is reused, so a poll loop cannot flood the inbox.
 *
 * 0.9.2 (复核 NOTES)：去重键补上 `attempt_id` 与 `options_json`——同一遍里重复的轮询仍只问
 * 一次，但换了 attempt 或换了可选项就是另一个问题，不该被前一问吞掉。
 */
function attentionOnceInTx(db, { questionId, taskId, attemptId, kind, prompt, optionsJson, expiresAt, now }) {
  const existing = db
    .prepare(
      `SELECT question_id FROM attention
        WHERE task_id = ? AND kind = ? AND prompt = ? AND status = 'open'
          AND COALESCE(attempt_id, '') = COALESCE(?, '')
          AND COALESCE(options_json, '') = COALESCE(?, '')`,
    )
    .get(taskId, kind, prompt, attemptId ?? null, optionsJson ?? null);
  if (existing) {
    return { questionId: existing.question_id, deduplicated: true };
  }
  db.prepare(
    `INSERT INTO attention (
       question_id, task_id, attempt_id, kind, prompt, options_json, status, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(questionId, taskId, attemptId, kind, prompt, optionsJson, expiresAt, now);
  return { questionId, deduplicated: false };
}

function closeOpenAttentionInTx(db, { taskId, attemptId = null, resolvedBy = "system", resolution = {}, now }) {
  const params = [resolvedBy, JSON.stringify(resolution), now, taskId];
  let sql = `UPDATE attention SET status = 'closed', resolved_by = ?, resolution_json = ?, resolved_at = ?
             WHERE task_id = ? AND status = 'open'`;
  if (attemptId) {
    sql += " AND (attempt_id = ? OR attempt_id IS NULL)";
    params.push(attemptId);
  }
  db.prepare(sql).run(...params);

  const appParams = [now, taskId];
  let appSql = `UPDATE approvals SET status = 'closed', decided_at = COALESCE(decided_at, ?)
                WHERE task_id = ? AND status = 'pending'`;
  if (attemptId) {
    appSql += " AND attempt_id = ?";
    appParams.push(attemptId);
  }
  db.prepare(appSql).run(...appParams);
}

function readTaskDetailInDb(db, taskId) {
  const row = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
  if (!row) return null;

  const attentionRows = db
    .prepare("SELECT * FROM attention WHERE task_id = ? ORDER BY created_at ASC")
    .all(taskId);
  const openAttention = attentionRows.filter(isAttentionOpen);

  const pendingApprovals = db
    .prepare("SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC")
    .all(taskId);

  const activeAttempt = row.active_attempt_id
    ? db.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(row.active_attempt_id)
    : db
        .prepare("SELECT * FROM attempts WHERE task_id = ? ORDER BY attempt_no DESC LIMIT 1")
        .get(taskId);

  const undelivered = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM inputs
       WHERE task_id = ? AND delivery_status IN ('queued', 'retrying')`,
    )
    .get(taskId);

  const activeLeaseEffect = db
    .prepare(
      `SELECT lease_expires_at FROM effects
       WHERE task_id = ? AND lease_expires_at IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(taskId);

  const lastEvent = db
    .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT 1")
    .get(taskId);

  const unsupportedCancelEvt = db
    .prepare("SELECT * FROM events WHERE task_id = ? AND type = 'cancel.unsupported' ORDER BY seq DESC LIMIT 1")
    .get(taskId);

  const artifacts = db
    .prepare("SELECT artifact_id, kind, size_bytes, sha256, created_at FROM artifacts WHERE task_id = ? ORDER BY created_at ASC")
    .all(taskId);

  const agentRow = row.agent_id
    ? db.prepare("SELECT capabilities_json FROM agents WHERE agent_id = ?").get(row.agent_id)
    : null;

  const phaseInfo = derivePhase(
    {
      status: row.status,
      undeliveredInputCount: undelivered.cnt,
      leaseExpiresAt: activeLeaseEffect?.lease_expires_at ?? null,
    },
    attentionRows,
    lastEvent ? { type: lastEvent.type, seq: lastEvent.seq } : null,
  );

  return {
    taskId: row.task_id,
    principalId: row.principal_id,
    idempotencyKey: row.idempotency_key,
    capabilityRevisionId: row.capability_revision_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    previewId: row.preview_id ?? null,
    status: row.status,
    stateVersion: row.state_version,
    phase: phaseInfo.phase,
    phaseLabel: phaseInfo.label,
    degraded: degradedFromCapabilities(agentRow?.capabilities_json),
    activeAttemptId: row.active_attempt_id ?? null,
    activeAttempt: activeAttempt
      ? {
          attemptId: activeAttempt.attempt_id,
          attemptNo: activeAttempt.attempt_no,
          status: activeAttempt.status,
          failureClass: activeAttempt.failure_class ?? null,
          sideEffectActive: activeAttempt.side_effect_active === 1,
          startedAt: activeAttempt.started_at,
          endedAt: activeAttempt.ended_at ?? null,
        }
      : null,
    pending: {
      attention: openAttention.map((a) => ({
        questionId: a.question_id,
        kind: a.kind,
        prompt: a.prompt,
        options: parseJson(a.options_json, []),
        expiresAt: a.expires_at ?? null,
        createdAt: a.created_at,
      })),
      approvals: pendingApprovals.map((ap) => ({
        approvalId: ap.approval_id,
        attemptId: ap.attempt_id,
        summary: ap.summary,
        scope: parseJson(ap.scope_json, {}),
        expiresAt: ap.expires_at,
      })),
    },
    artifacts: artifacts.map((art) => ({
      artifactId: art.artifact_id,
      kind: art.kind,
      sizeBytes: art.size_bytes,
      sha256: art.sha256 ?? null,
      createdAt: art.created_at,
    })),
    result: row.result_json ? parseJson(row.result_json, null) : null,
    resultValid: row.result_valid === null ? null : row.result_valid === 1,
    error: row.error_json ? parseJson(row.error_json, null) : null,
    cancelRequestedAt: row.cancel_requested_at ?? null,
    cancelReason: row.cancel_reason ?? null,
    ...(unsupportedCancelEvt
      ? { notice: "该执行方无法停止，请人工确认" }
      : {}),
    lastEvent: lastEvent
      ? {
          eventId: lastEvent.event_id,
          seq: lastEvent.seq,
          type: lastEvent.type,
          source: lastEvent.source,
          createdAt: lastEvent.created_at,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}

/**
 * Seed helpers for tests and W2/W3 bootstrap.
 */
export async function seedBaselineEntities(
  store,
  {
    principal = null,
    workspace = null,
    agent = null,
    capabilityRevision = null,
    preview = null,
  } = {},
) {
  const now = new Date().toISOString();
  return store.withWriteTx((db) => {
    if (principal) {
      db.prepare(
        `INSERT OR IGNORE INTO principals (principal_id, kind, scopes_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        principal.principalId,
        principal.kind ?? "operator",
        JSON.stringify(principal.scopes ?? ["task:submit", "task:read", "task:cancel", "approval:decide", "task:resolve"]),
        now,
        now,
      );
    }
    if (workspace) {
      db.prepare(
        `INSERT OR IGNORE INTO workspaces (workspace_id, root_path, allowed_side_effects_json, policy_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        workspace.workspaceId,
        workspace.rootPath,
        JSON.stringify(workspace.allowedSideEffects ?? ["read", "write"]),
        JSON.stringify(workspace.policy ?? {}),
        now,
        now,
      );
    }
    if (agent) {
      db.prepare(
        `INSERT OR IGNORE INTO agents (agent_id, adapter_kind, adapter_config_ref, manifest_revision, capabilities_json, probe_status, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        agent.agentId,
        agent.adapterKind ?? "dsh",
        agent.adapterConfigRef ?? "",
        agent.manifestRevision ?? "rev-1",
        JSON.stringify({
          cancel: agent.capabilities?.cancel ?? "supported",
          ...(agent.capabilities ?? {}),
          // A seeded instance behaves like a registered one: it declares the
          // revision it can execute, so preview can check ownership.
          ...(capabilityRevision
            ? {
                capabilityRevisions: [
                  {
                    capabilityId: capabilityRevision.capability,
                    version: Number(capabilityRevision.version ?? 1),
                    revisionId: capabilityRevision.revisionId,
                  },
                ],
              }
            : {}),
        }),
        agent.probeStatus ?? "verified",
        agent.enabled === false ? 0 : 1,
        now,
      );
    }
    if (capabilityRevision) {
      db.prepare(
        `INSERT OR IGNORE INTO capability_revisions (revision_id, capability, version, schema_json, side_effect_kind, cancel_policy, limitations_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        capabilityRevision.revisionId,
        capabilityRevision.capability,
        capabilityRevision.version ?? "1",
        JSON.stringify(capabilityRevision.schema ?? {}),
        capabilityRevision.sideEffectKind ?? "read",
        capabilityRevision.cancelPolicy ?? "required",
        JSON.stringify(capabilityRevision.limitations ?? ["local workspace only"]),
        now,
      );
    }
    if (preview) {
      db.prepare(
        `INSERT OR IGNORE INTO previews (preview_id, principal_id, normalized_request_json, candidates_json, selected_agent_id, selection_reason, policy_revision, capability_revision_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        preview.previewId,
        preview.principalId,
        JSON.stringify(preview.normalizedRequest ?? {}),
        JSON.stringify(preview.candidates ?? []),
        preview.selectedAgentId,
        preview.selectionReason ?? "selected",
        preview.policyRevision ?? "v1",
        preview.capabilityRevisionId,
        preview.expiresAt ?? new Date(Date.now() + 600_000).toISOString(),
        now,
      );
    }
  });
}

/**
 * Create a service engine bound to a SQLite store (zero adapter calls).
 */
export function createTaskEngine(store, options = {}) {
  const defaultPrincipalId = options.defaultPrincipalId ?? "local-operator";

  return {
    store,
    derivePhase,

    /**
     * Idempotently submit a new task (`queued`).
     * Deduplicates on `(principalId, idempotencyKey)`: identical request returns
     * the existing task; conflicting request with the same key throws
     * `IDEMPOTENCY_CONFLICT`.
     */
    async submit(params = {}) {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw validationFailed("params must be an object");
      }
      const principalId =
        params.principalId === undefined ? defaultPrincipalId : requireNonEmptyString(params.principalId, "principalId");
      const idempotencyKey = requireNonEmptyString(params.idempotencyKey, "idempotencyKey");
      const previewId =
        params.previewId === undefined || params.previewId === null
          ? null
          : requireNonEmptyString(params.previewId, "previewId");

      const canonicalRequest = {
        previewId,
        requestDigest: params.requestDigest ?? null,
        capabilityRevisionId: params.capabilityRevisionId ?? null,
        capability: params.capability ?? null,
        workspaceId: params.workspaceId ?? null,
        agentId: params.agentId ?? null,
        input: params.input ?? null,
        requestSummary: params.requestSummary ?? null,
        sourceTaskId: params.sourceTaskId ?? null,
      };
      const requestHash = hashRequest(canonicalRequest);

      return store.withWriteTx((db) => {
        const existing = db
          .prepare("SELECT * FROM tasks WHERE principal_id = ? AND idempotency_key = ?")
          .get(principalId, idempotencyKey);

        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw idempotencyConflict(
              `idempotencyKey "${idempotencyKey}" already used with a different request payload`,
              { principalId, idempotencyKey, existingTaskId: existing.task_id },
            );
          }
          const detail = readTaskDetailInDb(db, existing.task_id);
          return { ...detail, deduplicated: true };
        }

        const now = new Date().toISOString();
        const principal = db.prepare("SELECT * FROM principals WHERE principal_id = ?").get(principalId);
        if (!principal) {
          throw notFoundError(`principal not found: ${principalId}`, { principalId });
        }
        if (principal.revoked_at) {
          throw accessDeniedError(`principal "${principalId}" is revoked`, { principalId });
        }

        let workspaceId = params.workspaceId ? requireNonEmptyString(params.workspaceId, "workspaceId") : null;
        let agentId = params.agentId ? requireNonEmptyString(params.agentId, "agentId") : null;
        let capabilityRevisionId = params.capabilityRevisionId
          ? requireNonEmptyString(params.capabilityRevisionId, "capabilityRevisionId")
          : null;
        let requestSummary = params.requestSummary ?? (params.input ? { input: params.input } : {});

        if (previewId) {
          const consumed = consumePreviewInTx(db, {
            previewId,
            principalId,
            requestDigest: params.requestDigest,
          });
          if (workspaceId && consumed.workspaceId && workspaceId !== consumed.workspaceId) {
            throw taskError(TASK_ERROR.PREVIEW_MISMATCH, `preview "${previewId}" workspaceId mismatch`, {
              previewId,
            });
          }
          if (agentId && consumed.agentId && agentId !== consumed.agentId) {
            throw taskError(TASK_ERROR.PREVIEW_MISMATCH, `preview "${previewId}" agentId mismatch`, {
              previewId,
            });
          }
          if (
            capabilityRevisionId &&
            consumed.capabilityRevisionId &&
            capabilityRevisionId !== consumed.capabilityRevisionId
          ) {
            throw taskError(
              TASK_ERROR.PREVIEW_MISMATCH,
              `preview "${previewId}" capabilityRevisionId mismatch`,
              { previewId },
            );
          }
          workspaceId = workspaceId ?? consumed.workspaceId ?? null;
          agentId = agentId ?? consumed.agentId ?? null;
          capabilityRevisionId = capabilityRevisionId ?? consumed.capabilityRevisionId ?? null;
          requestSummary = params.requestSummary ?? consumed.normalizedRequest;
        }

        if (!workspaceId) throw validationFailed("`workspaceId` is required", { field: "workspaceId" });
        if (!agentId) throw validationFailed("`agentId` is required", { field: "agentId" });
        if (!capabilityRevisionId) {
          throw validationFailed("`capabilityRevisionId` is required", { field: "capabilityRevisionId" });
        }

        const workspace = db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspaceId);
        if (!workspace) throw notFoundError(`workspace not found: ${workspaceId}`, { workspaceId });
        if (workspace.revoked_at) throw accessDeniedError(`workspace "${workspaceId}" is revoked`, { workspaceId });

        const agent = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId);
        if (!agent) throw notFoundError(`agent not found: ${agentId}`, { agentId });
        if (agent.enabled !== 1) throw validationFailed(`agent "${agentId}" is disabled`, { agentId });

        const capRev = db
          .prepare("SELECT * FROM capability_revisions WHERE revision_id = ?")
          .get(capabilityRevisionId);
        if (!capRev) {
          throw notFoundError(`capability revision not found: ${capabilityRevisionId}`, {
            capabilityRevisionId,
          });
        }

        const taskId = `task_${randomUUID()}`;
        const mandateId = `mnd_${randomUUID()}`;
        const sourceTaskId = params.sourceTaskId ?? null;

        db.prepare(
          `INSERT INTO tasks (
             task_id, principal_id, idempotency_key, request_hash,
             capability_revision_id, workspace_id, agent_id, preview_id,
             request_summary_json, status, state_version, source_task_id,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?)`,
        ).run(
          taskId,
          principalId,
          idempotencyKey,
          requestHash,
          capabilityRevisionId,
          workspaceId,
          agentId,
          previewId,
          JSON.stringify(requestSummary ?? {}),
          sourceTaskId,
          now,
          now,
        );

        db.prepare(
          `INSERT INTO mandates (
             mandate_id, principal_id, task_id, workspace_id, agent_id,
             allowed_ops_json, policy_revision, expires_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          mandateId,
          principalId,
          taskId,
          workspaceId,
          agentId,
          JSON.stringify(params.allowedOps ?? [capRev.side_effect_kind]),
          params.policyRevision ?? "v1",
          params.mandateExpiresAt ?? null,
          now,
        );

        appendEventInTx(db, {
          taskId,
          attemptId: null,
          type: "task.accepted",
          source: "engine",
          payload: {
            principalId,
            agentId,
            workspaceId,
            capabilityRevisionId,
            mandateId,
            stateVersion: 1,
          },
          createdAt: now,
        });

        const detail = readTaskDetailInDb(db, taskId);
        return { ...detail, mandateId, deduplicated: false };
      });
    },

    /** Read one task with derived phase, active attempt, pending attention, and artifacts. */
    async get(params = {}) {
      const taskId = requireNonEmptyString(params.taskId, "taskId");
      const principalId = params.principalId ? requireNonEmptyString(params.principalId, "principalId") : null;
      return store.read((db) => {
        const detail = readTaskDetailInDb(db, taskId);
        if (!detail || (principalId && detail.principalId !== principalId)) {
          throw notFoundError(`task not found: ${taskId}`, { taskId });
        }
        return detail;
      });
    },

    /** List tasks with optional status/workspace/principal filters and cursor pagination. */
    async list(params = {}) {
      const limitRaw = params.limit ?? 50;
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 200) {
        throw validationFailed("`limit` must be an integer between 1 and 200", { limit: limitRaw });
      }
      const where = [];
      const args = [];
      if (params.principalId !== undefined && params.principalId !== null && params.principalId !== "") {
        where.push("principal_id = ?");
        args.push(requireNonEmptyString(params.principalId, "principalId"));
      }
      if (params.status !== undefined && params.status !== null && params.status !== "") {
        where.push("status = ?");
        args.push(requireNonEmptyString(params.status, "status"));
      }
      if (params.workspaceId !== undefined && params.workspaceId !== null && params.workspaceId !== "") {
        where.push("workspace_id = ?");
        args.push(requireNonEmptyString(params.workspaceId, "workspaceId"));
      }
      if (params.cursor !== undefined && params.cursor !== null && params.cursor !== "") {
        const cur = decodeCursor(params.cursor);
        where.push("(updated_at < ? OR (updated_at = ? AND task_id < ?))");
        args.push(cur.updatedAt, cur.updatedAt, cur.taskId);
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      return store.read((db) => {
        const rows = db
          .prepare(
            `SELECT task_id FROM tasks ${whereSql}
             ORDER BY updated_at DESC, task_id DESC
             LIMIT ?`,
          )
          .all(...args, limitRaw + 1);

        const hasMore = rows.length > limitRaw;
        const pageRows = hasMore ? rows.slice(0, limitRaw) : rows;
        const items = pageRows.map((r) => readTaskDetailInDb(db, r.task_id));
        const last = items[items.length - 1];
        const nextCursor =
          hasMore && last ? encodeCursor({ updatedAt: last.updatedAt, taskId: last.taskId }) : null;
        return { items, nextCursor, hasMore };
      });
    },

    /**
     * Read ordered events for a task. Throws `CURSOR_EXPIRED` if `afterSeq`
     * points before the earliest retained event sequence.
     */
    async events(params = {}) {
      const taskId = requireNonEmptyString(params.taskId, "taskId");
      const afterSeq = params.afterSeq ?? 0;
      const limit = params.limit ?? 100;
      if (!Number.isInteger(afterSeq) || afterSeq < 0) {
        throw validationFailed("`afterSeq` must be a non-negative integer", { afterSeq });
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw validationFailed("`limit` must be an integer between 1 and 500", { limit });
      }
      return store.read((db) => {
        const task = db.prepare("SELECT task_id FROM tasks WHERE task_id = ?").get(taskId);
        if (!task) throw notFoundError(`task not found: ${taskId}`, { taskId });

        const bounds = db
          .prepare("SELECT MIN(seq) AS min_seq, MAX(seq) AS max_seq FROM events WHERE task_id = ?")
          .get(taskId);
        if (bounds.min_seq !== null && afterSeq > 0 && afterSeq < bounds.min_seq - 1) {
          throw cursorExpired(`event cursor ${afterSeq} expired; earliest available seq is ${bounds.min_seq}`, {
            taskId,
            afterSeq,
            earliestSeq: bounds.min_seq,
          });
        }

        const rows = db
          .prepare(
            `SELECT * FROM events
             WHERE task_id = ? AND seq > ?
             ORDER BY seq ASC
             LIMIT ?`,
          )
          .all(taskId, afterSeq, limit + 1);

        const hasMore = rows.length > limit;
        const slice = hasMore ? rows.slice(0, limit) : rows;
        const items = slice.map((r) => ({
          eventId: r.event_id,
          taskId: r.task_id,
          seq: r.seq,
          attemptId: r.attempt_id ?? null,
          type: r.type,
          source: r.source,
          adapterEventId: r.adapter_event_id ?? null,
          payload: parseJson(r.payload_json, {}),
          evidence: parseJson(r.evidence_json, null),
          createdAt: r.created_at,
        }));
        const nextAfterSeq = items.length > 0 ? items[items.length - 1].seq : afterSeq;
        return { taskId, events: items, nextAfterSeq, hasMore };
      });
    },

    /**
     * Durable cancel registration (§5.2 & §5.5).
     * Never claims the runtime has already stopped. If the assigned agent has
     * `cancel === "unsupported"`, skips `cancel_requested`, transitions straight
     * to `needs_reconcile`, and records a `cancel.unsupported` event.
     */
    async cancel(params = {}) {
      const taskId = requireNonEmptyString(params.taskId, "taskId");
      const idempotencyKey = requireNonEmptyString(params.idempotencyKey, "idempotencyKey");
      const expectedStateVersion = params.expectedStateVersion;
      if (!Number.isInteger(expectedStateVersion) || expectedStateVersion < 1) {
        throw validationFailed("`expectedStateVersion` must be a positive integer", {
          expectedStateVersion,
        });
      }
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      const principalId = params.principalId ? requireNonEmptyString(params.principalId, "principalId") : null;

      return store.withWriteTx((db) => {
        const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
        if (!task || (principalId && task.principal_id !== principalId)) {
          throw notFoundError(`task not found: ${taskId}`, { taskId });
        }

        const existingEffect = db
          .prepare(
            `SELECT * FROM effects
             WHERE task_id = ? AND op_type = 'cancel' AND idempotency_key = ?`,
          )
          .get(taskId, idempotencyKey);
        if (existingEffect) {
          // A replay must carry the same request; comparing only the key would answer a
          // changed reason with the first receipt and hide the caller's mistake.
          const storedSummary = parseJson(existingEffect.request_summary_json, null) ?? {};
          // Only the intent decides a replay: `expectedStateVersion` is a concurrency guard
          // that naturally moves between retries, so comparing it would break honest retries.
          if ((storedSummary.reason ?? "") !== (reason ?? "")) {
            throw stateConflict(
              `idempotencyKey "${idempotencyKey}" was already used for this task with a different cancel request`,
              { taskId, idempotencyKey, reason: "idempotency_payload_mismatch" },
            );
          }
          const receipt = parseJson(existingEffect.receipt_json, {});
          return { ...receipt, stateVersion: task.state_version, status: task.status, deduplicated: true };
        }

        if (TERMINAL_STATES.has(task.status)) {
          throw stateConflict(
            `task ${taskId} is already in terminal state "${task.status}" and cannot be cancelled`,
            { taskId, status: task.status, stateVersion: task.state_version },
          );
        }

        const agent = db.prepare("SELECT capabilities_json FROM agents WHERE agent_id = ?").get(task.agent_id);
        const agentCaps = parseJson(agent?.capabilities_json, {});
        const cancelCap =
          agentCaps?.controls?.cancel?.support ??
          agentCaps?.card?.controls?.cancel?.support ??
          agentCaps?.cancel;
        const cancelUnsupported = cancelCap === "unsupported" || cancelCap === false;

        const now = new Date().toISOString();
        const operationId = `op_${randomUUID()}`;

        if (cancelUnsupported) {
          const notice = "该执行方无法停止，请人工确认";
          const tr = transitionInTx(db, {
            taskId,
            expectedStateVersion,
            to: "needs_reconcile",
            reason: reason || "executor does not support cancel",
            eventType: "cancel.unsupported",
            source: "engine",
            payload: {
              operationId,
              idempotencyKey,
              notice,
              agentId: task.agent_id,
            },
            patch: {
              cancelRequestedAt: now,
              cancelReason: reason || null,
            },
          });

          const receipt = {
            requestAccepted: true,
            taskId,
            status: tr.to,
            stateVersion: tr.stateVersion,
            operationId,
            unsupported: true,
            notice,
          };

          db.prepare(
            `INSERT INTO effects (
               operation_id, task_id, attempt_id, op_type, idempotency_key,
               request_summary_json, status, receipt_json, created_at, updated_at
             ) VALUES (?, ?, ?, 'cancel', ?, ?, 'unsupported', ?, ?, ?)`,
          ).run(
            operationId,
            taskId,
            task.active_attempt_id ?? null,
            idempotencyKey,
            JSON.stringify({ expectedStateVersion, reason }),
            JSON.stringify(receipt),
            now,
            now,
          );

          return { ...receipt, deduplicated: false };
        }

        // §5.2: a queued task that was never dispatched has nothing to stop and
        // no reconciler to wait for, so the withdraw is final immediately.
        if (task.status === "queued" && !task.active_attempt_id) {
          const tr = transitionInTx(db, {
            taskId,
            expectedStateVersion,
            to: "cancelled",
            reason: reason || "withdrawn before dispatch",
            eventType: "cancel.confirmed",
            source: "engine",
            payload: { operationId, idempotencyKey, withdrawnBeforeDispatch: true },
            patch: {
              cancelRequestedAt: now,
              cancelReason: reason || null,
              activeAttemptId: null,
            },
          });

          const receipt = {
            requestAccepted: true,
            taskId,
            status: tr.to,
            stateVersion: tr.stateVersion,
            operationId,
            unsupported: false,
            alreadyStopped: true,
          };

          db.prepare(
            `INSERT INTO effects (
               operation_id, task_id, attempt_id, op_type, idempotency_key,
               request_summary_json, status, receipt_json, created_at, updated_at
             ) VALUES (?, ?, ?, 'cancel', ?, ?, 'completed', ?, ?, ?)`,
          ).run(
            operationId,
            taskId,
            null,
            idempotencyKey,
            JSON.stringify({ expectedStateVersion, reason, withdrawnBeforeDispatch: true }),
            JSON.stringify(receipt),
            now,
            now,
          );

          return { ...receipt, deduplicated: false };
        }

        const tr = transitionInTx(db, {
          taskId,
          expectedStateVersion,
          to: "cancel_requested",
          reason,
          eventType: "cancel.requested",
          source: "engine",
          payload: {
            operationId,
            idempotencyKey,
          },
          patch: {
            cancelRequestedAt: now,
            cancelReason: reason || null,
          },
        });

        const receipt = {
          requestAccepted: true,
          taskId,
          status: tr.to,
          stateVersion: tr.stateVersion,
          operationId,
          unsupported: false,
        };

        db.prepare(
          `INSERT INTO effects (
             operation_id, task_id, attempt_id, op_type, idempotency_key,
             request_summary_json, status, receipt_json, created_at, updated_at
           ) VALUES (?, ?, ?, 'cancel', ?, ?, 'queued', ?, ?, ?)`,
        ).run(
          operationId,
          taskId,
          task.active_attempt_id ?? null,
          idempotencyKey,
          JSON.stringify({ expectedStateVersion, reason }),
          JSON.stringify(receipt),
          now,
          now,
        );

        return { ...receipt, deduplicated: false };
      });
    },

    /**
     * Decide a pending approval bound to `(taskId, attemptId, approvalId)`.
     */
    async decideApproval(params = {}) {
      const taskId = requireNonEmptyString(params.taskId, "taskId");
      const attemptId = requireNonEmptyString(params.attemptId, "attemptId");
      const approvalId = requireNonEmptyString(params.approvalId, "approvalId");
      const idempotencyKey = requireNonEmptyString(params.idempotencyKey, "idempotencyKey");
      const decision = requireNonEmptyString(params.decision, "decision");
      if (!["allow-once", "reject"].includes(decision)) {
        throw validationFailed('`decision` must be "allow-once" or "reject"', { decision });
      }
      const decidedBy = typeof params.decidedBy === "string" && params.decidedBy.trim() ? params.decidedBy.trim() : defaultPrincipalId;
      const note = typeof params.note === "string" ? params.note.trim() : "";

      return store.withWriteTx((db) => {
        const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
        if (!task) throw notFoundError(`task not found: ${taskId}`, { taskId });
        if (TERMINAL_STATES.has(task.status)) {
          throw stateConflict(`task ${taskId} is terminal (${task.status})`, { taskId, status: task.status });
        }
        if (task.active_attempt_id !== attemptId) {
          throw stateConflict(`attempt ${attemptId} is not the active attempt for task ${taskId}`, {
            taskId,
            attemptId,
            activeAttemptId: task.active_attempt_id,
          });
        }

        const approval = db
          .prepare("SELECT * FROM approvals WHERE approval_id = ? AND task_id = ? AND attempt_id = ?")
          .get(approvalId, taskId, attemptId);
        if (!approval) {
          throw notFoundError(`approval not found: ${approvalId}`, { taskId, attemptId, approvalId });
        }

        if (approval.status === "decided") {
          if (approval.idempotency_key === idempotencyKey && approval.decision === decision) {
            return {
              approvalId,
              taskId,
              attemptId,
              decision: approval.decision,
              status: task.status,
              stateVersion: task.state_version,
              deduplicated: true,
            };
          }
          throw stateConflict(`approval ${approvalId} already decided as "${approval.decision}"`, {
            approvalId,
            decision: approval.decision,
          });
        }

        if (Date.parse(approval.expires_at) <= Date.now()) {
          throw stateConflict(`approval ${approvalId} has expired`, {
            approvalId,
            expiresAt: approval.expires_at,
          });
        }

        const now = new Date().toISOString();
        db.prepare(
          `UPDATE approvals
           SET status = 'decided', decision = ?, decided_by = ?, decision_note = ?, idempotency_key = ?, decided_at = ?
           WHERE approval_id = ?`,
        ).run(decision, decidedBy, note || null, idempotencyKey, now, approvalId);

        db.prepare(
          `UPDATE attention
           SET status = 'closed', resolved_by = ?, resolution_json = ?, resolved_at = ?
           WHERE question_id = ? AND task_id = ? AND status = 'open'`,
        ).run(decidedBy, JSON.stringify({ decision, note }), now, approvalId, taskId);

        const operationId = `op_${randomUUID()}`;
        db.prepare(
          `INSERT INTO effects (
             operation_id, task_id, attempt_id, op_type, idempotency_key,
             request_summary_json, status, receipt_json, created_at, updated_at
           ) VALUES (?, ?, ?, 'decide_approval', ?, ?, 'queued', ?, ?, ?)`,
        ).run(
          operationId,
          taskId,
          attemptId,
          idempotencyKey,
          JSON.stringify({ approvalId, decision, note }),
          JSON.stringify({ approvalId, decision, decidedBy }),
          now,
          now,
        );

        let stateVersion = task.state_version;
        let status = task.status;
        if (task.status === "waiting_approval") {
          const tr = transitionInTx(db, {
            taskId,
            expectedStateVersion: task.state_version,
            to: "running",
            reason: `approval ${decision}`,
            eventType: "approval.decided",
            source: "operator",
            attemptId,
            payload: { approvalId, decision, decidedBy, note, operationId },
          });
          stateVersion = tr.stateVersion;
          status = tr.to;
        } else {
          appendEventInTx(db, {
            taskId,
            attemptId,
            type: "approval.decided",
            source: "operator",
            payload: { approvalId, decision, decidedBy, note, operationId },
          });
        }

        return {
          approvalId,
          taskId,
          attemptId,
          decision,
          status,
          stateVersion,
          operationId,
          deduplicated: false,
        };
      });
    },

    /**
     * Operator resolution for `review_pending` or `needs_reconcile` (§6.1).
     */
    async resolve(params = {}) {
      const taskId = requireNonEmptyString(params.taskId, "taskId");
      const idempotencyKey = requireNonEmptyString(params.idempotencyKey, "idempotencyKey");
      const expectedStateVersion = params.expectedStateVersion;
      if (!Number.isInteger(expectedStateVersion) || expectedStateVersion < 1) {
        throw validationFailed("`expectedStateVersion` must be a positive integer", {
          expectedStateVersion,
        });
      }
      const disposition = requireNonEmptyString(params.disposition, "disposition");
      const map = {
        accept: "succeeded",
        succeeded: "succeeded",
        reject: "failed",
        failed: "failed",
        cancel: "cancelled",
        cancelled: "cancelled",
        requeue: "queued",
      };
      const targetState = map[disposition];
      if (!targetState) {
        throw validationFailed(`unsupported disposition "${disposition}"`, { disposition });
      }
      const resolvedBy =
        typeof params.resolvedBy === "string" && params.resolvedBy.trim()
          ? params.resolvedBy.trim()
          : defaultPrincipalId;
      const evidenceRef = params.evidenceRef ?? null;
      const note = typeof params.note === "string" ? params.note.trim() : "";

      return store.withWriteTx((db) => {
        const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
        if (!task) throw notFoundError(`task not found: ${taskId}`, { taskId });

        const existingEffect = db
          .prepare(
            `SELECT * FROM effects
             WHERE task_id = ? AND op_type = 'resolve' AND idempotency_key = ?`,
          )
          .get(taskId, idempotencyKey);
        if (existingEffect) {
          // Same rule as cancel(): a different disposition under the same key is a
          // conflict, not a replay.
          const storedSummary = parseJson(existingEffect.request_summary_json, null) ?? {};
          if (
            storedSummary.disposition !== disposition ||
            (storedSummary.evidenceRef ?? null) !== (evidenceRef ?? null)
          ) {
            throw stateConflict(
              `idempotencyKey "${idempotencyKey}" was already used for this task with a different resolve request`,
              { taskId, idempotencyKey, reason: "idempotency_payload_mismatch" },
            );
          }
          return { ...readTaskDetailInDb(db, taskId), deduplicated: true };
        }

        // §5.3: an unvalidated `ready` report keeps the task `running` and posts an
        // open `review` attention, so that attention is the operator's licence to
        // adjudicate: promoting to `review_pending` first keeps one auditable path
        // for both validated and unvalidated results (event `review.promoted`).
        const reviewAttention =
          task.status === "running" || task.status === "waiting_input" || task.status === "waiting_approval"
            ? db
                .prepare(
                  `SELECT * FROM attention
                   WHERE task_id = ? AND kind = 'review' AND status = 'open'
                   ORDER BY created_at LIMIT 1`,
                )
                .get(taskId)
            : null;
        const adjudicable = reviewAttention && (targetState === "succeeded" || targetState === "failed");

        if (task.status !== "review_pending" && task.status !== "needs_reconcile" && !adjudicable) {
          throw stateConflict(
            `task ${taskId} in state "${task.status}" cannot be resolved (must be review_pending, needs_reconcile, or running with an open review attention)`,
            { taskId, status: task.status, stateVersion: task.state_version },
          );
        }
        if (task.status === "review_pending" && targetState === "queued") {
          throw stateConflict(`review_pending task ${taskId} cannot be requeued directly`, {
            taskId,
            status: task.status,
          });
        }
        if (targetState === "queued") {
          const activeAttempt = db
            .prepare("SELECT attempt_id FROM attempts WHERE task_id = ? AND side_effect_active = 1")
            .get(taskId);
          if (activeAttempt) {
            throw stateConflict(
              `cannot requeue task ${taskId} while attempt ${activeAttempt.attempt_id} still holds active side effects`,
              { taskId, activeAttemptId: activeAttempt.attempt_id },
            );
          }
        }

        const now = new Date().toISOString();
        let resolveVersion = expectedStateVersion;
        if (adjudicable) {
          // Unvalidated result: the operator's disposition is what promotes it into
          // human review, so the promotion is recorded with `resultValid: false`.
          const promotion = transitionInTx(db, {
            taskId,
            expectedStateVersion,
            to: "review_pending",
            reason: note || "operator adjudicated an unvalidated result",
            evidence: evidenceRef ? { evidenceRef } : null,
            eventType: "review.promoted",
            source: "operator",
            attemptId: task.active_attempt_id ?? null,
            payload: {
              questionId: reviewAttention.question_id,
              promotedFrom: task.status,
              resolvedBy,
              resultValid: false,
            },
            patch: { resultValid: false },
          });
          resolveVersion = promotion.stateVersion;
        }
        closeOpenAttentionInTx(db, {
          taskId,
          resolvedBy,
          resolution: { disposition, evidenceRef, note, ...(adjudicable ? { promoted: true } : {}) },
          now,
        });

        const tr = transitionInTx(db, {
          taskId,
          expectedStateVersion: resolveVersion,
          to: targetState,
          reason: note || `resolved as ${disposition}`,
          evidence: evidenceRef ? { evidenceRef } : null,
          eventType: "task.resolved",
          source: "operator",
          // 0.9.2：把「这条结果到底有没有过校验」写进事件。人工接受一个没过校验的结果是
          // 合法动作，但事后翻账本时不能看不出这件事。
          payload: {
            disposition,
            resolvedBy,
            idempotencyKey,
            evidenceRef,
            note,
            resultValid: task.result_valid === 1,
            ...(adjudicable && targetState === "succeeded" ? { acceptedUnvalidated: true } : {}),
          },
          patch: {
            ...(TERMINAL_STATES.has(targetState) ? { activeAttemptId: null } : {}),
            ...(targetState === "failed" && note
              ? { errorJson: JSON.stringify({ message: note, failureClass: "review_rejected" }) }
              : {}),
          },
        });

        const operationId = `op_${randomUUID()}`;
        db.prepare(
          `INSERT INTO effects (
             operation_id, task_id, attempt_id, op_type, idempotency_key,
             request_summary_json, status, receipt_json, created_at, updated_at
           ) VALUES (?, ?, ?, 'resolve', ?, ?, 'completed', ?, ?, ?)`,
        ).run(
          operationId,
          taskId,
          task.active_attempt_id ?? null,
          idempotencyKey,
          JSON.stringify({ disposition, expectedStateVersion, evidenceRef }),
          JSON.stringify({ targetState, stateVersion: tr.stateVersion }),
          now,
          now,
        );

        return { ...readTaskDetailInDb(db, taskId), deduplicated: false };
      });
    },

    /**
     * Create an attempt record and advance `queued -> dispatching -> running` (or
     * `queued -> dispatching`) in DB. Used by tests and W2 runtime dispatcher.
     */
    async recordAttemptStart(params = {}) {
      const taskId = requireNonEmptyString(params.taskId, "taskId");
      const expectedStateVersion = params.expectedStateVersion;
      const runtimeLocator = params.runtimeLocator ?? null;
      const markRunning = params.markRunning !== false;

      return store.withWriteTx((db) => {
        const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
        if (!task) throw notFoundError(`task not found: ${taskId}`, { taskId });
        const mandate = db
          .prepare("SELECT mandate_id FROM mandates WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
          .get(taskId);
        const attemptNoRow = db
          .prepare("SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next_no FROM attempts WHERE task_id = ?")
          .get(taskId);

        const now = new Date().toISOString();
        const attemptId = `att_${randomUUID()}`;

        if (task.status === "dispatching") {
          db.prepare(
            `INSERT INTO attempts (
               attempt_id, task_id, attempt_no, agent_id, mandate_id, capability_revision_id,
               runtime_locator_json, status, side_effect_active, started_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          ).run(
            attemptId,
            taskId,
            attemptNoRow.next_no,
            task.agent_id,
            mandate?.mandate_id ?? null,
            task.capability_revision_id,
            runtimeLocator ? JSON.stringify(runtimeLocator) : null,
            markRunning ? "running" : "dispatching",
            now,
            now,
          );

          let tr = { to: "dispatching", stateVersion: task.state_version };
          if (markRunning) {
            db.prepare("UPDATE tasks SET active_attempt_id = ? WHERE task_id = ?").run(attemptId, taskId);
            tr = transitionInTx(db, {
              taskId,
              expectedStateVersion: expectedStateVersion ?? task.state_version,
              to: "running",
              eventType: "attempt.started",
              attemptId,
              evidence: runtimeLocator ? { runtimeLocator } : null,
              payload: { attemptNo: attemptNoRow.next_no },
            });
          } else {
            // Staying in dispatching is still a state change: it must honour the optimistic
            // lock, otherwise a stale caller silently rebinds the active attempt.
            const expectedForWrite = expectedStateVersion ?? task.state_version;
            const moved = db
              .prepare(
                `UPDATE tasks
                    SET active_attempt_id = ?, state_version = state_version + 1, updated_at = ?
                  WHERE task_id = ? AND state_version = ?`,
              )
              .run(attemptId, now, taskId, expectedForWrite);
            if (moved.changes !== 1) {
              throw stateConflict(`task ${taskId} changed while recording the attempt`, {
                taskId,
                expectedStateVersion: expectedForWrite,
              });
            }
            tr = { to: "dispatching", stateVersion: expectedForWrite + 1 };
          }
          return {
            attemptId,
            attemptNo: attemptNoRow.next_no,
            taskId,
            status: tr.to,
            stateVersion: tr.stateVersion,
          };
        }

        db.prepare(
          `INSERT INTO attempts (
             attempt_id, task_id, attempt_no, agent_id, mandate_id, capability_revision_id,
             runtime_locator_json, status, side_effect_active, started_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(
          attemptId,
          taskId,
          attemptNoRow.next_no,
          task.agent_id,
          mandate?.mandate_id ?? null,
          task.capability_revision_id,
          runtimeLocator ? JSON.stringify(runtimeLocator) : null,
          markRunning ? "running" : "dispatching",
          now,
          now,
        );

        let tr = transitionInTx(db, {
          taskId,
          expectedStateVersion,
          to: "dispatching",
          eventType: "dispatch.selected",
          attemptId,
          payload: { attemptNo: attemptNoRow.next_no },
          patch: { activeAttemptId: attemptId },
        });

        if (markRunning) {
          tr = transitionInTx(db, {
            taskId,
            expectedStateVersion: tr.stateVersion,
            to: "running",
            eventType: "attempt.started",
            attemptId,
            evidence: runtimeLocator ? { runtimeLocator } : null,
            payload: { attemptNo: attemptNoRow.next_no },
          });
        }

        return {
          attemptId,
          attemptNo: attemptNoRow.next_no,
          taskId,
          status: tr.to,
          stateVersion: tr.stateVersion,
        };
      });
    },

    /**
     * Apply a six-state adapter report (`progress`, `waiting`, `ready`, `blocked`,
     * `failed`, `dropped`) onto the authoritative task state machine (§5.3 & §5.5).
     */
    async applyReport(params = {}) {
      return applyReport(store, params);
    },
    async input(params = {}) {
      return recordInput(store, params);
    },
    async readArtifact(params = {}) {
      return readArtifact(store, params);
    },
  };
}


/**
 * §5: record the artifacts a report claims, verifying the bytes first.
 * Returns what was accepted and what was refused, so the caller can log both.
 */
export function recordArtifactsInTx(db, { taskId, attemptId = null, claims = [], now } = {}) {
  const at = now ?? new Date().toISOString();
  const accepted = [];
  const refused = [];
  for (const claim of claims) {
    const verdict = verifyArtifactClaim(claim);
    if (!verdict.ok) {
      refused.push({
        name: typeof claim?.name === "string" ? claim.name : null,
        reason: verdict.reason,
      });
      continue;
    }
    const { artifact } = verdict;
    const artifactId = artifactIdFor(taskId, artifact.sha256, artifact.kind);
    db.prepare(
      `INSERT OR IGNORE INTO artifacts
         (artifact_id, task_id, attempt_id, kind, size_bytes, sha256, source_path, access_policy_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      artifactId,
      taskId,
      attemptId,
      artifact.kind,
      artifact.sizeBytes,
      artifact.sha256,
      artifact.sourcePath,
      JSON.stringify({ visibility: "task" }),
      at,
    );
    accepted.push({ artifactId, kind: artifact.kind, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 });
  }
  return { accepted, refused };
}

/**
 * §6.1 dsh.tasks.input: durable registration of a human answer. The answer is
 * delivered by the dispatcher (adapter.sendInput); this only records intent, so a
 * crash between accepting and delivering cannot lose the text.
 */
export async function recordInput(store, params = {}) {
  const taskId = requireNonEmptyString(params.taskId, "taskId");
  const idempotencyKey = requireNonEmptyString(params.idempotencyKey, "idempotencyKey");
  const text = requireNonEmptyString(params.text, "text");
  const questionId = params.questionId ? requireNonEmptyString(params.questionId, "questionId") : null;
  const attemptIdParam = params.attemptId ? requireNonEmptyString(params.attemptId, "attemptId") : null;

  return store.withWriteTx((db) => {
    const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    if (!task) throw notFoundError(`task not found: ${taskId}`, { taskId });

    const existing = db
      .prepare("SELECT * FROM inputs WHERE task_id = ? AND idempotency_key = ?")
      .get(taskId, idempotencyKey);
    if (existing) {
      const same = existing.text === text && (existing.question_id ?? null) === questionId;
      if (!same) {
        throw idempotencyConflict(
          `idempotencyKey "${idempotencyKey}" was already used with a different input`,
          { taskId, idempotencyKey },
        );
      }
      return {
        inputId: existing.input_id,
        taskId,
        attemptId: existing.attempt_id,
        deliveryStatus: existing.delivery_status,
        deduplicated: true,
      };
    }

    if (TERMINAL_STATES.has(task.status)) {
      throw stateConflict(`task ${taskId} is already ${task.status}; input is no longer accepted`, {
        taskId,
        status: task.status,
        reason: "TASK_FINISHED",
      });
    }
    const activeAttemptId = task.active_attempt_id ?? null;
    if (!activeAttemptId) {
      throw stateConflict(`task ${taskId} has no active attempt to receive input`, {
        taskId,
        reason: "NO_ACTIVE_ATTEMPT",
      });
    }
    if (attemptIdParam && attemptIdParam !== activeAttemptId) {
      throw stateConflict(`attempt ${attemptIdParam} is not the active attempt`, {
        taskId,
        attemptId: attemptIdParam,
        activeAttemptId,
        reason: "ATTEMPT_MISMATCH",
      });
    }
    if (task.status !== "running" && task.status !== "waiting_input") {
      throw stateConflict(
        `task ${taskId} is ${task.status}; input is only accepted while running or waiting for an answer`,
        { taskId, status: task.status, reason: "INPUT_NOT_ACCEPTED" },
      );
    }
    if (questionId) {
      const question = db
        .prepare("SELECT * FROM attention WHERE question_id = ? AND task_id = ?")
        .get(questionId, taskId);
      if (!question) {
        throw stateConflict(`question ${questionId} is not open on task ${taskId}`, {
          taskId,
          questionId,
          reason: "STALE_QUESTION",
        });
      }
      if (question.status !== "open") {
        throw stateConflict(`question ${questionId} is already ${question.status}`, {
          taskId,
          questionId,
          status: question.status,
          reason: "QUESTION_CLOSED",
        });
      }
    }

    const now = new Date().toISOString();
    const inputId = "in_" + randomUUID();
    const operationId = "op_" + randomUUID();
    db.prepare(
      `INSERT INTO inputs
         (input_id, task_id, attempt_id, question_id, idempotency_key, text, delivery_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(inputId, taskId, activeAttemptId, questionId, idempotencyKey, text, now, now);
    db.prepare(
      `INSERT INTO effects
         (operation_id, task_id, attempt_id, op_type, idempotency_key, request_summary_json, status, created_at, updated_at)
       VALUES (?, ?, ?, 'input', ?, ?, 'queued', ?, ?)`,
    ).run(operationId, taskId, activeAttemptId, idempotencyKey, JSON.stringify({ text, questionId }), now, now);
    appendEventInTx(db, {
      taskId,
      attemptId: activeAttemptId,
      type: "input.queued",
      source: "engine",
      payload: { inputId, operationId, questionId },
    });

    return {
      inputId,
      taskId,
      attemptId: activeAttemptId,
      deliveryStatus: "queued",
      operationId,
      deduplicated: false,
    };
  });
}

/** §6.1 dsh.tasks.readArtifact: bounded, authoritative read of a recorded artifact. */
export async function readArtifact(store, params = {}) {
  const taskId = requireNonEmptyString(params.taskId, "taskId");
  const artifactId = requireNonEmptyString(params.artifactId, "artifactId");
  const offset = params.offset === undefined || params.offset === null ? 0 : params.offset;
  const length = params.length === undefined || params.length === null ? undefined : params.length;
  if (!Number.isInteger(offset) || offset < 0) {
    throw validationFailed("offset must be a non-negative integer", { field: "offset" });
  }
  if (length !== undefined && (!Number.isInteger(length) || length < 1)) {
    throw validationFailed("length must be a positive integer", { field: "length" });
  }

  const row = store.read((db) =>
    db.prepare("SELECT * FROM artifacts WHERE artifact_id = ? AND task_id = ?").get(artifactId, taskId),
  );
  if (!row) throw notFoundError(`artifact not found: ${artifactId}`, { taskId, artifactId });

  const window = readArtifactWindow({ sourcePath: row.source_path, offset, length });
  if (!window.ok) {
    throw notFoundError(`artifact bytes are unavailable: ${window.reason}`, {
      taskId,
      artifactId,
      reason: window.reason,
    });
  }
  return {
    taskId,
    artifactId,
    kind: row.kind,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    sourcePath: row.source_path,
    createdAt: row.created_at,
    encoding: window.encoding,
    content: window.content,
    offset: window.offset,
    bytesRead: window.bytesRead,
    truncated: window.truncated,
  };
}

/**
 * Standalone §5.3 report mapper: translates adapter report declarations into
 * authoritative task-state transitions and events.
 */
export async function applyReport(store, params = {}) {
  const taskId = requireNonEmptyString(params.taskId, "taskId");
  const attemptId = params.attemptId ? requireNonEmptyString(params.attemptId, "attemptId") : null;
  const report = params.report;
  const adapterEventId = params.adapterEventId ?? null;
  const source = typeof params.source === "string" && params.source.trim() ? params.source.trim() : "adapter";

  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw validationFailed("`report` must be an object");
  }
  if (!REPORT_STATES.has(report.state)) {
    throw validationFailed(`invalid report state "${String(report.state)}"`, { state: report.state });
  }

  const sanitizeAtt = (att) => {
    if (!att || typeof att !== "object" || Array.isArray(att)) return att;
    return {
      ...att,
      ...(typeof att.prompt === "string" ? { prompt: redactSecrets(att.prompt, { maxChars: 2000 }) } : {}),
      ...(typeof att.summary === "string" ? { summary: redactSecrets(att.summary, { maxChars: 2000 }) } : {}),
    };
  };
  const safeReport = {
    ...report,
    ...(typeof report.message === "string" ? { message: redactSecrets(report.message, { maxChars: 2000 }) } : {}),
    ...(typeof report.summary === "string" ? { summary: redactSecrets(report.summary, { maxChars: 2000 }) } : {}),
    ...(typeof report.reason === "string" ? { reason: redactSecrets(report.reason, { maxChars: 2000 }) } : {}),
    ...(typeof report.reviewPrompt === "string"
      ? { reviewPrompt: redactSecrets(report.reviewPrompt, { maxChars: 2000 }) }
      : {}),
    ...(report.attention !== undefined
      ? {
          attention: Array.isArray(report.attention)
            ? report.attention.map(sanitizeAtt)
            : sanitizeAtt(report.attention),
        }
      : {}),
  };

  return store.withWriteTx((db) => {
    const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    if (!task) throw notFoundError(`task not found: ${taskId}`, { taskId });

    if (attemptId) {
      const attempt = db
        .prepare("SELECT * FROM attempts WHERE attempt_id = ? AND task_id = ?")
        .get(attemptId, taskId);
      if (!attempt) {
        throw notFoundError(`attempt not found: ${attemptId}`, { taskId, attemptId });
      }
      if (adapterEventId !== null && adapterEventId !== undefined) {
        const dup = db
          .prepare(
            "SELECT event_id, seq FROM events WHERE task_id = ? AND attempt_id = ? AND adapter_event_id = ?",
          )
          .get(taskId, attemptId, String(adapterEventId));
        if (dup) {
          return {
            taskId,
            status: task.status,
            stateVersion: task.state_version,
            deduplicated: true,
          };
        }
      }
    }

    const now = new Date().toISOString();

    // §5: artifacts arrive as claims inside the report. The centre records only the
    // bytes it can verify, and reports every refused claim instead of dropping it.
    const artifactNotes = recordArtifactsInTx(db, {
      taskId,
      attemptId: attemptId ?? task.active_attempt_id ?? null,
      claims: Array.isArray(report.artifacts) ? report.artifacts : [],
      now,
    });
    if (artifactNotes.accepted.length > 0) {
      appendEventInTx(db, {
        taskId,
        attemptId: attemptId ?? task.active_attempt_id ?? null,
        type: "artifact.indexed",
        source,
        payload: { artifacts: artifactNotes.accepted },
      });
    }
    if (artifactNotes.refused.length > 0) {
      appendEventInTx(db, {
        taskId,
        attemptId: attemptId ?? task.active_attempt_id ?? null,
        type: "artifact.refused",
        source,
        payload: { refused: artifactNotes.refused },
      });
    }

    // Terminal state or stale attempt: never mutate task status; record late event only (§5.2 & §5.5).
    if (TERMINAL_STATES.has(task.status) || (attemptId && task.active_attempt_id && attemptId !== task.active_attempt_id)) {
      const evt = appendEventInTx(db, {
        taskId,
        attemptId,
        type: "report.late",
        source,
        adapterEventId,
        payload: {
          reportState: report.state,
          currentStatus: task.status,
          activeAttemptId: task.active_attempt_id ?? null,
        },
        evidence: report.evidence ?? null,
        createdAt: now,
      });
      return {
        taskId,
        status: task.status,
        stateVersion: task.state_version,
        ignoredLateReport: true,
        event: evt,
      };
    }

    const resolvedAttemptId = attemptId ?? task.active_attempt_id ?? null;

    if (safeReport.state === "progress") {
      const progressPayload = {
        message: safeReport.message ?? "",
        ...(safeReport.summary !== undefined ? { summary: safeReport.summary } : {}),
      };
      if (task.status === "dispatching") {
        const tr = transitionInTx(db, {
          taskId,
          expectedStateVersion: task.state_version,
          to: "running",
          eventType: "attempt.progress",
          source,
          attemptId: resolvedAttemptId,
          adapterEventId,
          payload: progressPayload,
          evidence: safeReport.evidence ?? null,
        });
        return { taskId, status: tr.to, stateVersion: tr.stateVersion, event: tr.event };
      }
      const evt = appendEventInTx(db, {
        taskId,
        attemptId: resolvedAttemptId,
        type: "attempt.progress",
        source,
        adapterEventId,
        payload: progressPayload,
        evidence: safeReport.evidence ?? null,
        createdAt: now,
      });
      return { taskId, status: task.status, stateVersion: task.state_version, event: evt };
    }

    if (safeReport.state === "waiting") {
      if (!validateStructuredAttention(safeReport.attention)) {
        const evt = appendEventInTx(db, {
          taskId,
          attemptId: resolvedAttemptId,
          type: "report.malformed",
          source,
          adapterEventId,
          payload: { reportState: "waiting", reason: "missing or invalid structured attention" },
          evidence: safeReport.evidence ?? null,
          createdAt: now,
        });
        return { taskId, status: task.status, stateVersion: task.state_version, malformed: true, event: evt };
      }

      if (task.status === "cancel_requested") {
        const evt = appendEventInTx(db, {
          taskId,
          attemptId: resolvedAttemptId,
          type: "report.disputed",
          source,
          adapterEventId,
          payload: { reportState: "waiting", currentStatus: task.status },
          evidence: safeReport.evidence ?? null,
          createdAt: now,
        });
        return { taskId, status: task.status, stateVersion: task.state_version, disputed: true, event: evt };
      }

      const att = safeReport.attention;
      const questionId = att.questionId ?? `q_${randomUUID()}`;
      const expiresAt = att.expiresAt ?? new Date(Date.now() + 600_000).toISOString();

      attentionOnceInTx(db, {
        questionId,
        taskId,
        attemptId: resolvedAttemptId,
        kind: att.kind,
        prompt: att.prompt.trim(),
        optionsJson: JSON.stringify(att.options ?? []),
        expiresAt,
        now,
      });

      if (att.kind === "approval") {
        db.prepare(
          `INSERT INTO approvals (
             approval_id, task_id, attempt_id, scope_json, summary, status, expires_at, created_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(
          questionId,
          taskId,
          resolvedAttemptId,
          JSON.stringify(att.scope ?? {}),
          att.prompt.trim(),
          expiresAt,
          now,
        );
      }

      const targetState = att.kind === "approval" ? "waiting_approval" : "waiting_input";
      if (task.status === targetState) {
        const evt = appendEventInTx(db, {
          taskId,
          attemptId: resolvedAttemptId,
          type: "attention.opened",
          source,
          adapterEventId,
          payload: { questionId, kind: att.kind },
          evidence: report.evidence ?? null,
          createdAt: now,
        });
        return { taskId, status: task.status, stateVersion: task.state_version, questionId, event: evt };
      }

      const tr = transitionInTx(db, {
        taskId,
        expectedStateVersion: task.state_version,
        to: targetState,
        eventType: "attention.opened",
        source,
        attemptId: resolvedAttemptId,
        adapterEventId,
        payload: { questionId, kind: att.kind },
        evidence: report.evidence ?? null,
      });
      return { taskId, status: tr.to, stateVersion: tr.stateVersion, questionId, event: tr.event };
    }

    if (report.state === "ready") {
      const schemaOk =
        report.resultValid !== false &&
        report.schemaValid !== false &&
        report.result !== undefined &&
        report.result !== null;

      if (!schemaOk) {
        // §5.3: `ready` with failed schema validation stays `running`, records `report.invalid`,
        // and posts `attention.kind = "review"` for human judgment — never directly `failed`.
        // 0.9.0 live (acceptance run 10): two consecutive pumps both surfaced a `ready`
        // report, and the raw insert opened two identical review questions for one problem.
        // Route it through the same idempotent helper the other questions use, so one problem
        // asks once — a poll loop must not flood the operator's inbox.
        const prompt =
          typeof safeReport.reviewPrompt === "string" && safeReport.reviewPrompt.trim()
            ? safeReport.reviewPrompt.trim()
            : "Execution reported ready, but output failed schema validation; human review required.";
        // 0.9.2（复核 NOTES）：结果没过校验，但它仍是机器真实产出的东西。让人判收/拒，
        // 就得让人先看得见它——只在事件里留 validationErrors 等于凭空气决定。照样落库，
        // 同时把 result_valid 显式置 0：看得见不等于认可。
        const storedInvalidResult = report.result !== undefined && report.result !== null;
        if (storedInvalidResult) {
          db.prepare(`UPDATE tasks SET result_json = ?, result_valid = 0, updated_at = ? WHERE task_id = ?`).run(
            JSON.stringify(report.result),
            now,
            taskId,
          );
        }
        const { questionId } = attentionOnceInTx(db, {
          questionId: `q_${randomUUID()}`,
          taskId,
          attemptId: resolvedAttemptId,
          kind: "review",
          prompt,
          optionsJson: JSON.stringify(["accept", "reject"]),
          expiresAt: null,
          now,
        });

        const evt = appendEventInTx(db, {
          taskId,
          attemptId: resolvedAttemptId,
          type: "report.invalid",
          source,
          adapterEventId,
          payload: {
            questionId,
            validationErrors: report.validationErrors ?? ["result failed schema check"],
            resultStored: storedInvalidResult,
          },
          evidence: report.evidence ?? null,
          createdAt: now,
        });
        return {
          taskId,
          status: task.status,
          stateVersion: task.state_version,
          reportInvalid: true,
          questionId,
          event: evt,
        };
      }

      closeOpenAttentionInTx(db, {
        taskId,
        attemptId: resolvedAttemptId,
        resolvedBy: "system",
        resolution: { closedBy: "attempt_ready" },
        now,
      });
      if (resolvedAttemptId) {
        db.prepare(
          `UPDATE attempts
           SET status = 'completed', side_effect_active = 0, ended_at = COALESCE(ended_at, ?), updated_at = ?
           WHERE attempt_id = ?`,
        ).run(now, now, resolvedAttemptId);
      }
      const tr = transitionInTx(db, {
        taskId,
        expectedStateVersion: task.state_version,
        to: "review_pending",
        eventType: "attempt.ready",
        source,
        attemptId: resolvedAttemptId,
        adapterEventId,
        payload: { resultValid: true },
        evidence: report.evidence ?? null,
        patch: {
          resultJson: JSON.stringify(report.result),
          resultValid: true,
        },
      });
      return { taskId, status: tr.to, stateVersion: tr.stateVersion, event: tr.event };
    }

    if (safeReport.state === "blocked") {
      if (validateStructuredAttention(safeReport.attention)) {
        const att = safeReport.attention;
        // 0.9.2：这里原来把 `attentionOnceInTx` 的返回值丢了——去重命中时它复用旧问题，但对外
        // 报的仍是新生成的 uuid，调用方等于拿到一个不存在的问题号。改成用账本里的那一号。
        // 0.9.2 复核：`repeated` 必须反映「去重命中」，不是「任务已经在等」。等待中输入
        // 另一个问题同样是新问题，标成 repeated 会让事件骗人，所以把 deduplicated 也取出来。
        const { questionId, deduplicated } = attentionOnceInTx(db, {
          questionId: att.questionId ?? `q_${randomUUID()}`,
          taskId,
          attemptId: resolvedAttemptId,
          kind: att.kind === "approval" ? "input" : att.kind,
          prompt: att.prompt.trim(),
          optionsJson: JSON.stringify(att.options ?? []),
          expiresAt: att.expiresAt ?? null,
          now,
        });
        // 0.9.2：轮询会重复投递同一条 blocked 报告。已经在等这个问题的任务不该因此撞状态机
        // （`waiting_input -> waiting_input` 是非法迁移）；已在该状态时只补一条事件。
        if (task.status === "waiting_input") {
          const repeated = appendEventInTx(db, {
            taskId,
            attemptId: resolvedAttemptId,
            type: "attention.opened",
            source,
            adapterEventId,
            payload: { questionId, repeated: Boolean(deduplicated) },
            evidence: safeReport.evidence ?? null,
            createdAt: now,
          });
          return {
            taskId,
            status: task.status,
            stateVersion: task.state_version,
            questionId,
            event: repeated,
          };
        }

        const tr = transitionInTx(db, {
          taskId,
          expectedStateVersion: task.state_version,
          to: "waiting_input",
          eventType: "attempt.blocked",
          source,
          attemptId: resolvedAttemptId,
          adapterEventId,
          payload: { questionId },
          evidence: safeReport.evidence ?? null,
        });
        return { taskId, status: tr.to, stateVersion: tr.stateVersion, questionId, event: tr.event };
      }
      if (typeof safeReport.failureClass === "string" && safeReport.failureClass.trim().length > 0) {
        closeOpenAttentionInTx(db, {
          taskId,
          attemptId: resolvedAttemptId,
          resolvedBy: "system",
          resolution: { closedBy: "attempt_blocked_failed" },
          now,
        });
        if (resolvedAttemptId) {
          db.prepare(
            `UPDATE attempts
             SET status = 'failed', failure_class = ?, side_effect_active = 0, ended_at = COALESCE(ended_at, ?), updated_at = ?
             WHERE attempt_id = ?`,
          ).run(safeReport.failureClass.trim(), now, now, resolvedAttemptId);
        }
        const tr = transitionInTx(db, {
          taskId,
          expectedStateVersion: task.state_version,
          to: "failed",
          reason: safeReport.reason ?? safeReport.failureClass,
          eventType: "attempt.failed",
          source,
          attemptId: resolvedAttemptId,
          adapterEventId,
          payload: { failureClass: safeReport.failureClass.trim(), fromBlocked: true },
          evidence: safeReport.evidence ?? null,
          patch: {
            activeAttemptId: null,
            errorJson: JSON.stringify({
              failureClass: safeReport.failureClass.trim(),
              message: safeReport.reason ?? "blocked without question",
            }),
          },
        });
        return { taskId, status: tr.to, stateVersion: tr.stateVersion, event: tr.event };
      }

      // Free-text only blocked report is forbidden (§5.3).
      const evt = appendEventInTx(db, {
        taskId,
        attemptId: resolvedAttemptId,
        type: "report.malformed",
        source,
        adapterEventId,
        payload: {
          reportState: "blocked",
          reason: "blocked report must carry structured attention or failureClass",
        },
        evidence: safeReport.evidence ?? null,
        createdAt: now,
      });
      return { taskId, status: task.status, stateVersion: task.state_version, malformed: true, event: evt };
    }

    if (safeReport.state === "failed") {
      const failureClass =
        typeof safeReport.failureClass === "string" && safeReport.failureClass.trim()
          ? safeReport.failureClass.trim()
          : "runtime_error";
      closeOpenAttentionInTx(db, {
        taskId,
        attemptId: resolvedAttemptId,
        resolvedBy: "system",
        resolution: { closedBy: "attempt_failed" },
        now,
      });
      if (resolvedAttemptId) {
        db.prepare(
          `UPDATE attempts
           SET status = 'failed', failure_class = ?, side_effect_active = 0, ended_at = COALESCE(ended_at, ?), updated_at = ?
           WHERE attempt_id = ?`,
        ).run(failureClass, now, now, resolvedAttemptId);
      }
      const tr = transitionInTx(db, {
        taskId,
        expectedStateVersion: task.state_version,
        to: "failed",
        reason: safeReport.reason ?? failureClass,
        eventType: "attempt.failed",
        source,
        attemptId: resolvedAttemptId,
        adapterEventId,
        payload: { failureClass },
        evidence: safeReport.evidence ?? null,
        patch: {
          activeAttemptId: null,
          errorJson: JSON.stringify({ failureClass, message: safeReport.reason ?? failureClass }),
        },
      });
      return { taskId, status: tr.to, stateVersion: tr.stateVersion, event: tr.event };
    }

    // report.state === "dropped"
    const droppedBy = typeof safeReport.droppedBy === "string" ? safeReport.droppedBy.trim() : "";
    if (!["cancelled", "user", "agent"].includes(droppedBy)) {
      const evt = appendEventInTx(db, {
        taskId,
        attemptId: resolvedAttemptId,
        type: "report.malformed",
        source,
        adapterEventId,
        payload: { reportState: "dropped", reason: "droppedBy must be 'cancelled', 'user', or 'agent'" },
        evidence: safeReport.evidence ?? null,
        createdAt: now,
      });
      return { taskId, status: task.status, stateVersion: task.state_version, malformed: true, event: evt };
    }

    closeOpenAttentionInTx(db, {
      taskId,
      attemptId: resolvedAttemptId,
      resolvedBy: "system",
      resolution: { closedBy: `dropped:${droppedBy}` },
      now,
    });
    if (resolvedAttemptId) {
      db.prepare(
        `UPDATE attempts
         SET status = 'cancelled', side_effect_active = 0, ended_at = COALESCE(ended_at, ?), updated_at = ?
         WHERE attempt_id = ?`,
      ).run(now, now, resolvedAttemptId);
    }

    const tr = transitionInTx(db, {
      taskId,
      expectedStateVersion: task.state_version,
      to: "cancelled",
      reason: safeReport.reason ?? `dropped by ${droppedBy}`,
      eventType: droppedBy === "agent" ? "attempt.dropped" : "cancel.confirmed",
      source,
      attemptId: resolvedAttemptId,
      adapterEventId,
      payload: { droppedBy },
      evidence: report.evidence ?? null,
      patch: { activeAttemptId: null },
    });
    return { taskId, status: tr.to, stateVersion: tr.stateVersion, event: tr.event };
  });
}
