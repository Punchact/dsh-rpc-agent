// Bounded dispatch, pump, and effect-drain loop bridging the task ledger (`engine`/`store`)
// to external runtime adapters (`lib/adapters/*`).

import { validateAdapter } from "../adapters/base.mjs";
import { TASK_ERROR, notFoundError, stateConflict, taskError, validationFailed } from "./errors.mjs";
import { TERMINAL_STATES, transition, transitionInTx } from "./state-machine.mjs";

const DEFAULT_MAX_STEPS = 50;
const DEFAULT_DEADLINE_MS = 5_000;
const DEFAULT_EFFECT_LEASE_MS = 60_000;
const DEFAULT_MAX_CONCURRENT = 1;
const ACTIVE_STATES = [
  "dispatching",
  "running",
  "waiting_input",
  "waiting_approval",
  "cancel_requested",
];
const KNOWN_REPORT_STATES = new Set(["progress", "waiting", "ready", "blocked", "failed", "dropped"]);

function parseJson(text, fallback = null) {
  if (typeof text !== "string" || text.length === 0) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function projectTaskRow(row) {
  return {
    taskId: row.task_id,
    principalId: row.principal_id,
    capabilityRevisionId: row.capability_revision_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    status: row.status,
    stateVersion: row.state_version,
    activeAttemptId: row.active_attempt_id ?? null,
    requestSummary: parseJson(row.request_summary_json, {}),
  };
}

function projectAgentRow(row) {
  const caps = parseJson(row.capabilities_json, {});
  return {
    agentId: row.agent_id,
    adapterKind: row.adapter_kind,
    adapterConfigRef: row.adapter_config_ref,
    adapterConfig: parseJson(row.adapter_config_ref, {}),
    manifestRevision: row.manifest_revision,
    capabilities: caps,
  };
}

function projectWorkspaceRow(row) {
  return {
    workspaceId: row.workspace_id,
    rootPath: row.root_path,
    allowedSideEffects: parseJson(row.allowed_side_effects_json, []),
    policy: parseJson(row.policy_json, {}),
  };
}

/**
 * Create a bounded dispatcher connecting `store`/`engine` to `adapters`.
 */
export function createDispatcher({
  store,
  engine,
  adapters = {},
  now = Date.now,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
} = {}) {
  if (!store || !engine) {
    throw validationFailed("createDispatcher requires `store` and `engine`");
  }
  const concurrencyLimit =
    Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : DEFAULT_MAX_CONCURRENT;
  const validatedAdapters = {};
  for (const [kind, adapter] of Object.entries(adapters ?? {})) {
    validatedAdapters[kind] = validateAdapter(adapter);
  }

  function resolveAdapter(kind) {
    const adapter = validatedAdapters[kind];
    if (!adapter) {
      throw taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, `no adapter registered for kind "${kind}"`, {
        adapterKind: kind,
      });
    }
    return adapter;
  }

  return {
    /**
     * Dispatch a `queued` task via its assigned agent's adapter.
     * Transitions `queued -> dispatching` before calling `adapter.start`, then
     * advances to `running` on success or `needs_reconcile` (`dispatch.failed`) on throw.
     */
    async startTask(params = {}) {
      const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
      if (!taskId) throw validationFailed("`taskId` must be a non-empty string", { field: "taskId" });

      const loaded = store.read((db) => {
        const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
        if (!task) throw notFoundError(`task not found: ${taskId}`, { taskId });
        const agent = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(task.agent_id);
        if (!agent) throw notFoundError(`agent not found: ${task.agent_id}`, { agentId: task.agent_id });
        const workspace = db
          .prepare("SELECT * FROM workspaces WHERE workspace_id = ?")
          .get(task.workspace_id);
        if (!workspace) {
          throw notFoundError(`workspace not found: ${task.workspace_id}`, {
            workspaceId: task.workspace_id,
          });
        }
        return { task, agent, workspace };
      });

      if (loaded.task.status !== "queued") {
        throw stateConflict(
          `task ${taskId} must be in "queued" state to dispatch (got "${loaded.task.status}")`,
          { taskId, status: loaded.task.status, stateVersion: loaded.task.state_version },
        );
      }

      const adapter = resolveAdapter(loaded.agent.adapter_kind);

      // The concurrency check and the transition share one write transaction so two
      // dispatchers cannot both observe a free slot and then both claim it.
      const dispatching = await store.withWriteTx((db) => {
        const activeRow = db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM tasks WHERE status IN (${ACTIVE_STATES.map(() => "?").join(", ")})`,
          )
          .get(...ACTIVE_STATES);
        if (activeRow.cnt >= concurrencyLimit) {
          throw stateConflict(
            `concurrency limit (${concurrencyLimit}) reached; ${activeRow.cnt} active task(s)`,
            {
              reason: "max_concurrent",
              activeCount: activeRow.cnt,
              maxConcurrent: concurrencyLimit,
              taskId,
            },
          );
        }
        return transitionInTx(db, {
          taskId,
          expectedStateVersion: loaded.task.state_version,
          to: "dispatching",
          eventType: "dispatch.selected",
          source: "dispatcher",
          payload: { adapterKind: loaded.agent.adapter_kind, agentId: loaded.agent.agent_id },
        });
      });

      let startRes;
      try {
        startRes = await adapter.start({
          task: projectTaskRow(loaded.task),
          agent: projectAgentRow(loaded.agent),
          workspace: projectWorkspaceRow(loaded.workspace),
          ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
          ...(params.model !== undefined ? { model: params.model } : {}),
          ...(params.projectId !== undefined ? { projectId: params.projectId } : {}),
          ...(params.title !== undefined ? { title: params.title } : {}),
        });
      } catch (error) {
        const msg = error?.message ?? String(error);
        const rec = await transition(store, {
          taskId,
          expectedStateVersion: dispatching.stateVersion,
          to: "needs_reconcile",
          reason: msg,
          eventType: "dispatch.failed",
          source: "dispatcher",
          evidence: {
            message: msg,
            code: error?.taskCode ?? error?.code ?? null,
          },
          payload: {
            adapterKind: loaded.agent.adapter_kind,
            error: msg,
          },
          patch: {
            errorJson: JSON.stringify({
              failureClass: "dispatch_failed",
              message: msg,
              code: error?.taskCode ?? error?.code ?? null,
            }),
          },
        });
        return {
          taskId,
          status: rec.to,
          stateVersion: rec.stateVersion,
          dispatchFailed: true,
          error: msg,
        };
      }

      const locator = startRes?.locator ?? startRes ?? null;
      let attempt;
      try {
        attempt = await engine.recordAttemptStart({
          taskId,
          expectedStateVersion: dispatching.stateVersion,
          runtimeLocator: locator,
          markRunning: true,
        });
      } catch (error) {
        // The runtime is already running but the ledger refused the attempt
        // (typically a cancel landed first). Never lose the locator: it is the
        // only handle that can still stop that orphan run.
        const msg = error?.message ?? String(error);
        const current = store.read((db) => db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId));
        const base = { taskId, locator, orphan: true, dispatchFailed: false, error: msg };
        if (!current) return { ...base, status: null, stateVersion: null };
        try {
          const rec = await transition(store, {
            taskId,
            expectedStateVersion: current.state_version,
            to: "needs_reconcile",
            reason: `attempt not recorded after start: ${msg}`,
            eventType: "dispatch.orphaned",
            source: "dispatcher",
            evidence: { runtimeLocator: locator, message: msg },
            payload: { adapterKind: loaded.agent.adapter_kind, error: msg },
          });
          return { ...base, status: rec.to, stateVersion: rec.stateVersion };
        } catch {
          return { ...base, status: current.status, stateVersion: current.state_version };
        }
      }

      return {
        taskId,
        attemptId: attempt.attemptId,
        status: attempt.status,
        stateVersion: attempt.stateVersion,
        locator,
        dispatchFailed: false,
        ...(startRes?.warning ? { warning: startRes.warning } : {}),
      };
    },

    /**
     * Bounded pump: drains `adapter.events` / calls `adapter.inspect` and applies
     * reports to the engine. Unknown or unactionable `blocked` reports move the task
     * to `needs_reconcile` instead of fabricating completion.
     */
    async pump(params = {}) {
      const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
      if (!taskId) throw validationFailed("`taskId` must be a non-empty string", { field: "taskId" });
      const maxSteps =
        Number.isInteger(params.maxSteps) && params.maxSteps > 0 ? params.maxSteps : DEFAULT_MAX_STEPS;
      const deadlineMs =
        Number.isInteger(params.deadlineMs) && params.deadlineMs > 0 ? params.deadlineMs : DEFAULT_DEADLINE_MS;
      const deadline = now() + deadlineMs;
      let cursor = params.cursor ?? 0;

      const snapshot = () =>
        store.read((db) => {
          const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
          if (!task) throw notFoundError(`task not found: ${taskId}`, { taskId });
          const agent = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(task.agent_id);
          const attempt = task.active_attempt_id
            ? db.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(task.active_attempt_id)
            : db
                .prepare("SELECT * FROM attempts WHERE task_id = ? ORDER BY attempt_no DESC LIMIT 1")
                .get(taskId);
          return { task, agent, attempt };
        });

      let state = snapshot();
      if (
        TERMINAL_STATES.has(state.task.status) ||
        state.task.status === "needs_reconcile" ||
        state.task.status === "review_pending"
      ) {
        return {
          taskId,
          status: state.task.status,
          stateVersion: state.task.state_version,
          stepsProcessed: 0,
          nextCursor: cursor,
          hitMaxSteps: false,
          timedOut: false,
          reports: [],
        };
      }

      const adapter = resolveAdapter(state.agent.adapter_kind);
      const locator = parseJson(state.attempt?.runtime_locator_json, null);
      let stepsProcessed = 0;
      const reports = [];

      const handleReport = async (rawReport, adapterEventId = null) => {
        const report = rawReport?.report ?? rawReport;
        const rState = report?.state;
        const isUnknownOrPlainBlocked =
          !report ||
          typeof report !== "object" ||
          !KNOWN_REPORT_STATES.has(rState) ||
          (rState === "blocked" && !report.attention && !report.failureClass);

        if (isUnknownOrPlainBlocked) {
          state = snapshot();
          if (!TERMINAL_STATES.has(state.task.status) && state.task.status !== "needs_reconcile") {
            const tr = await transition(store, {
              taskId,
              expectedStateVersion: state.task.state_version,
              to: "needs_reconcile",
              reason: report?.reason ?? `adapter reported ${String(rState ?? "unknown")}`,
              eventType: "inspect.unknown",
              source: "dispatcher",
              attemptId: state.attempt?.attempt_id ?? null,
              evidence: report?.evidence ?? { rawReport: report ?? null },
            });
            reports.push({ state: rState ?? "unknown", reconciled: true, status: tr.to });
            return { stop: true };
          }
          return { stop: true };
        }

        const applied = await engine.applyReport({
          taskId,
          attemptId: state.attempt?.attempt_id ?? null,
          adapterEventId,
          report,
        });
        reports.push({ state: rState, status: applied.status });
        if (
          TERMINAL_STATES.has(applied.status) ||
          applied.status === "review_pending" ||
          applied.status === "needs_reconcile" ||
          applied.status === "waiting_input" ||
          applied.status === "waiting_approval"
        ) {
          return { stop: true };
        }
        return { stop: false };
      };

      while (stepsProcessed < maxSteps && now() < deadline) {
        const evResp = await adapter.events({ task: projectTaskRow(state.task), locator }, locator, cursor);
        const items = Array.isArray(evResp?.events) ? evResp.events : [];
        if (evResp?.nextCursor !== undefined) cursor = evResp.nextCursor;

        if (items.length > 0) {
          let stopped = false;
          for (const item of items) {
            if (stepsProcessed >= maxSteps || now() >= deadline) break;
            const r = item?.report ?? (KNOWN_REPORT_STATES.has(item?.state) ? item : null);
            if (!r) continue;
            stepsProcessed += 1;
            const res = await handleReport(r, item?.adapterEventId ?? null);
            if (res.stop) {
              stopped = true;
              break;
            }
          }
          if (stopped) break;
          if (evResp?.report) {
            if (stepsProcessed >= maxSteps || now() >= deadline) break;
            stepsProcessed += 1;
            const res = await handleReport(evResp.report, null);
            if (res.stop) break;
          }
          // If events yielded items and we haven't hit maxSteps, continue draining if cursor advanced
          if (items.length === 0) break;
        } else {
          const insp = await adapter.inspect({ task: projectTaskRow(state.task), locator }, locator);
          stepsProcessed += 1;
          await handleReport(insp, null);
          break;
        }
      }

      const finalState = snapshot();
      return {
        taskId,
        status: finalState.task.status,
        stateVersion: finalState.task.state_version,
        stepsProcessed,
        nextCursor: cursor,
        hitMaxSteps: stepsProcessed >= maxSteps,
        timedOut: now() >= deadline,
        reports,
      };
    },

    /**
     * Bounded effect drain: executes queued `cancel` / `decide_approval` effects at most once.
     */
    async drainEffects(params = {}) {
      const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 20;
      const maxSteps =
        Number.isInteger(params.maxSteps) && params.maxSteps > 0 ? params.maxSteps : DEFAULT_MAX_STEPS;
      const deadlineMs =
        Number.isInteger(params.deadlineMs) && params.deadlineMs > 0 ? params.deadlineMs : DEFAULT_DEADLINE_MS;
      const deadline = now() + deadlineMs;
      const leaseMs =
        Number.isInteger(params.leaseMs) && params.leaseMs > 0 ? params.leaseMs : DEFAULT_EFFECT_LEASE_MS;

      // Reclaim effects whose holder died mid-flight: without a lease a crashed
      // drain would strand a cancel in `in_flight` forever.
      await store.withWriteTx((db) => {
        const at = new Date(now()).toISOString();
        db.prepare(
          `UPDATE effects
              SET status = 'queued', lease_expires_at = NULL, updated_at = ?
            WHERE status = 'in_flight' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        ).run(at, at);
      });

      const pendingRows = store.read((db) =>
        db
          .prepare(
            `SELECT * FROM effects
             WHERE status = 'queued'
             ORDER BY created_at ASC
             LIMIT ?`,
          )
          .all(Math.min(limit, maxSteps)),
      );

      let processed = 0;
      let completed = 0;
      let failed = 0;
      let skipped = 0;

      for (const eff of pendingRows) {
        if (processed >= maxSteps || now() >= deadline) break;
        processed += 1;

        const claimTime = new Date(now()).toISOString();
        const leaseExpiry = new Date(now() + leaseMs).toISOString();
        const claimed = await store.withWriteTx((db) => {
          const res = db
            .prepare(
              `UPDATE effects SET status = 'in_flight', lease_expires_at = ?, updated_at = ?
               WHERE operation_id = ? AND status = 'queued'`,
            )
            .run(leaseExpiry, claimTime, eff.operation_id);
          return res.changes === 1;
        });

        if (!claimed) {
          skipped += 1;
          continue;
        }

        const ctxRows = store.read((db) => {
          const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(eff.task_id);
          const agent = task
            ? db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(task.agent_id)
            : null;
          const attemptId = eff.attempt_id ?? task?.active_attempt_id ?? null;
          const attempt = attemptId
            ? db.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(attemptId)
            : null;
          return { task, agent, attempt };
        });

        try {
          if (!ctxRows.task || !ctxRows.agent) {
            throw notFoundError(`task or agent missing for effect ${eff.operation_id}`);
          }
          const adapter = resolveAdapter(ctxRows.agent.adapter_kind);
          const locator = parseJson(ctxRows.attempt?.runtime_locator_json, null);
          const reqSummary = parseJson(eff.request_summary_json, {});

          let adapterResp;
          if (eff.op_type === "cancel") {
            adapterResp = await adapter.cancel(
              { task: projectTaskRow(ctxRows.task), locator },
              { locator, operation: eff, reason: reqSummary.reason ?? "" },
            );
          } else if (eff.op_type === "decide_approval") {
            adapterResp = await adapter.decideApproval(
              { task: projectTaskRow(ctxRows.task), locator },
              locator,
              reqSummary,
            );
          } else {
            throw validationFailed(`unsupported effect op_type "${eff.op_type}"`, {
              opType: eff.op_type,
            });
          }

          const doneAt = new Date(now()).toISOString();
          await store.withWriteTx((db) => {
            db.prepare(
              `UPDATE effects
               SET status = 'completed', receipt_json = ?, updated_at = ?
               WHERE operation_id = ?`,
            ).run(JSON.stringify(adapterResp ?? { ok: true }), doneAt, eff.operation_id);
          });
          completed += 1;
        } catch (error) {
          const failAt = new Date(now()).toISOString();
          const msg = error?.message ?? String(error);
          // A cancel that the runtime refused must become a human-visible
          // reconcile item, never a task that quietly stays "cancelling".
          if (eff.op_type === "cancel") {
            try {
              await transition(store, {
                taskId: eff.task_id,
                expectedStateVersion: ctxRows.task.state_version,
                to: "needs_reconcile",
                reason: `cancel effect failed: ${msg}`,
                eventType: "cancel.failed",
                source: "dispatcher",
                attemptId: ctxRows.attempt?.attempt_id ?? null,
                evidence: { operationId: eff.operation_id, message: msg },
                payload: { operationId: eff.operation_id, error: msg },
              });
            } catch {
              // Concurrent state change already moved the task; the effect receipt
              // below still records the failure.
            }
          }
          await store.withWriteTx((db) => {
            db.prepare(
              `UPDATE effects
               SET status = 'failed', reconcile_result_json = ?, updated_at = ?
               WHERE operation_id = ?`,
            ).run(
              JSON.stringify({ error: msg, code: error?.taskCode ?? error?.code ?? null }),
              failAt,
              eff.operation_id,
            );
          });
          failed += 1;
        }
      }

      return {
        processed,
        completed,
        failed,
        skipped,
        hitMaxSteps: processed >= maxSteps,
        timedOut: now() >= deadline,
      };
    },
  };
}
