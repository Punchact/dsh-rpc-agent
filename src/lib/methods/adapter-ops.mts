// 从 src/lib/methods.mts 原样搬出：createDshAdapterOps（把 DSH 会话操作包装成适配器七操作）
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
  ApprovalsServiceLike,
  DEFAULT_HISTORY_BUDGET_MS,
  MAX_WAIT_RECORDS,
  SelectedModel,
  SessionControllerLike,
  SessionControllerListedItem,
} from "./types.mjs";
import {
  readSessionSnapshot,
} from "./catalog.mjs";
import {
  findTurnEnd,
  num,
  projectEvent,
  reasonForEnd,
  summarizeRecords,
} from "./helpers.mjs";
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

export function createDshAdapterOps({
  sessionController,
  config = {},
  ctx: _ctx = null,
  approvals = null,
}: {
  sessionController?: SessionControllerLike | null | undefined;
  config?: Partial<ResolvedConfig> | undefined;
  ctx?: unknown;
  approvals?: ApprovalsServiceLike | null | undefined;
} = {}): DshSessionOps {
  const signal = new AbortController().signal;

  const wrapOp =
    <T extends Record<string, unknown>>(fn: (params: Record<string, unknown>) => Promise<T>) =>
    async (params: Record<string, unknown> = {}): Promise<T | { ok: false; reason: string }> => {
      try {
        return await fn(params ?? {});
      } catch (error) {
        const msg =
          error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message
            : String(error);
        return { ok: false, reason: msg };
      }
    };

  return {
    createSession: wrapOp(async (params) => {
      if (!sessionController || typeof sessionController.create !== "function") {
        return { ok: false, reason: "sessionController.create is unavailable" };
      }
      const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId.trim() : "";
      const explicitCwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
      if (workspaceId && explicitCwd) {
        return { ok: false, reason: "`workspaceId` and `cwd` cannot be combined" };
      }
      const cwd = workspaceId ? "" : explicitCwd || (typeof config?.defaultCwd === "string" ? config.defaultCwd.trim() : "");
      const preset =
        (typeof params.agentPreset === "string" ? params.agentPreset.trim() : "") ||
        (typeof config?.defaultAgentPreset === "string" ? config.defaultAgentPreset.trim() : "");
      const request: Record<string, unknown> = {};
      if (workspaceId) request.workspaceId = workspaceId;
      if (cwd) request.cwd = cwd;
      if (preset) request.agentPreset = preset;

      const value = await sessionController.create(request);
      const sessionId = typeof value?.sessionId === "string" ? value.sessionId.trim() : "";
      if (!sessionId) {
        return { ok: false, reason: "sessionController.create returned no sessionId" };
      }
      ownSession(sessionId);

      const model = typeof params.model === "string" ? params.model.trim() : "";
      const effort = typeof params.reasoningEffort === "string" ? params.reasoningEffort.trim() : "";
      if (model && typeof sessionController.selectModel === "function") {
        const slash = model.indexOf("/");
        let provider = "";
        let modelId = model;
        if (slash > 0) {
          provider = model.slice(0, slash);
          modelId = model.slice(slash + 1);
        } else if (typeof sessionController.modelCatalog === "function") {
          const catalog = await sessionController.modelCatalog();
          const hits: string[] = [];
          for (const group of catalog?.groups ?? []) {
            for (const entry of group.models ?? []) {
              if (entry?.id === model) hits.push(group.id);
            }
          }
          // hits.length === 1 checked immediately above.
          if (hits.length === 1) provider = hits[0] as string;
        }
        if (provider) {
          await sessionController.selectModel({
            sessionId,
            provider,
            model: modelId,
            ...(effort ? { reasoningEffort: effort } : {}),
          });
        }
      }

      return {
        ok: true,
        sessionId,
        agentPreset: value?.agentPreset ?? (preset || null),
      };
    }),

    askSession: wrapOp(async (params) => {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
      if (!sessionId) return { ok: false, reason: "`sessionId` is required" };
      if (!sessionController || typeof sessionController.prompt !== "function") {
        return { ok: false, reason: "sessionController.prompt is unavailable" };
      }
      const promptText = params.prompt ?? params.text ?? "";
      const requestId = `rpc-${randomUUID()}`;
      await sessionController.prompt(
        {
          requestId,
          sessionId,
          mode: "queue",
          content: [{ type: "text", text: String(promptText) }],
        },
        signal,
      );
      return { ok: true, accepted: true, status: "running", sessionId, requestId };
    }),

    promptSession: wrapOp(async (params) => {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
      if (!sessionId) return { ok: false, reason: "`sessionId` is required" };
      if (!sessionController || typeof sessionController.prompt !== "function") {
        return { ok: false, reason: "sessionController.prompt is unavailable" };
      }
      const mode = params.mode === "queue" ? "queue" : "steer";
      const text = params.text ?? params.prompt ?? "";
      const requestId = `rpc-${randomUUID()}`;
      await sessionController.prompt(
        {
          requestId,
          sessionId,
          mode,
          content: [{ type: "text", text: String(text) }],
        },
        signal,
      );
      return { ok: true, accepted: true, sessionId, requestId, mode };
    }),

    cancelSession: wrapOp(async (params) => {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
      if (!sessionId) return { ok: false, reason: "`sessionId` is required" };
      if (!sessionController || typeof sessionController.cancel !== "function") {
        return { ok: false, reason: "sessionController.cancel is unavailable" };
      }
      const value = await sessionController.cancel({ sessionId });
      return {
        ok: true,
        accepted: value?.accepted !== false,
        stopped: value?.stopped === true,
        sessionId,
      };
    }),

    sessionStatus: wrapOp(async (params) => {
      if (params.probe === true || !params.sessionId) {
        if (!sessionController || typeof sessionController.list !== "function") {
          return { ok: false, reason: "sessionController.list is unavailable" };
        }
        const listed = await sessionController.list({}, signal);
        const items = Array.isArray(listed?.items) ? listed.items : [];
        return { ok: true, probe: true, count: items.length };
      }

      const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
      if (!sessionId) return { ok: false, reason: "`sessionId` is required" };

      let pendingApproval: PendingApprovalPacket | null = null;
      if (approvals && typeof approvals.waitForAny === "function") {
        const answer = await approvals.waitForAny({ sessionId, waitMs: 0 });
        if (Array.isArray(answer?.pending) && answer.pending.length > 0) {
          pendingApproval = answer.pending[0] ?? null;
        }
      } else if (approvals && typeof approvals.pending === "function") {
        const listedApprovals = await approvals.pending(sessionId);
        if (Array.isArray(listedApprovals) && listedApprovals.length > 0) {
          pendingApproval = listedApprovals[0] ?? null;
        }
      }

      let listedItem: SessionControllerListedItem | null = null;
      if (typeof sessionController?.list === "function") {
        const listed = await sessionController.list({}, signal);
        listedItem = (listed?.items ?? []).find((it) => it?.sessionId === sessionId) ?? null;
      }

      if (pendingApproval) {
        return {
          ok: true,
          sessionId,
          status: "waiting_approval",
          running: Boolean(listedItem?.running),
          pendingApproval,
        };
      }

      if (listedItem?.running === true) {
        return { ok: true, sessionId, status: "running", running: true };
      }

      if (typeof sessionController?.follow === "function") {
        const budget = Number.isInteger(config?.historyBudgetMs)
          ? (config.historyBudgetMs as number)
          : DEFAULT_HISTORY_BUDGET_MS;
        const snapshot = await readSessionSnapshot(sessionController, {
          sessionId,
          limit: 40,
          budgetMs: budget,
        });
        if (!snapshot.missing) {
          const summary = summarizeRecords(snapshot.records);
          if (summary.running) {
            return { ok: true, sessionId, status: "running", running: true, turn: summary.turn };
          }
          if (summary.turn > 0) {
            const endEvent = findTurnEnd(summary.events, summary.turn);
            const reason = reasonForEnd(endEvent);
            if (endEvent) {
              const kind = reason?.kind ?? "completed";
              if (kind === "failed" || kind === "error" || kind === "aborted_error") {
                return {
                  ok: true,
                  sessionId,
                  status: "failed",
                  running: false,
                  turn: summary.turn,
                  error: reason?.message ?? "turn failed",
                };
              }
              if (kind === "cancelled" || kind === "canceled" || kind === "aborted" || kind === "interrupted") {
                return {
                  ok: true,
                  sessionId,
                  status: "cancelled",
                  running: false,
                  turn: summary.turn,
                  reason: reason?.message ?? "turn cancelled",
                };
              }
              return {
                ok: true,
                sessionId,
                status: kind === "completed" ? "completed" : kind,
                running: false,
                turn: summary.turn,
              };
            }
          }
        }
      }

      if (listedItem) {
        return {
          ok: true,
          sessionId,
          status: listedItem.blank ? "idle" : "completed",
          running: false,
        };
      }

      return { ok: false, reason: `session not found: ${sessionId}` };
    }),

    sessionHistory: wrapOp(async (params) => {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
      if (!sessionId) return { ok: false, reason: "`sessionId` is required" };
      if (!sessionController || typeof sessionController.follow !== "function") {
        return { ok: false, reason: "sessionController.follow is unavailable" };
      }
      const limit =
        typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit > 0 && params.limit <= MAX_WAIT_RECORDS
          ? params.limit
          : 40;
      const budget = Number.isInteger(config?.historyBudgetMs)
        ? (config.historyBudgetMs as number)
        : DEFAULT_HISTORY_BUDGET_MS;
      const snapshot = await readSessionSnapshot(sessionController, {
        sessionId,
        limit,
        budgetMs: budget,
      });
      if (snapshot.missing) {
        return { ok: true, sessionId, cursor: -1, records: [] };
      }
      const summary = summarizeRecords(snapshot.records);
      let events = summary.events;
      const afterSeq =
        typeof params.afterSeq === "number" && Number.isInteger(params.afterSeq) && params.afterSeq >= 0
          ? params.afterSeq
          : null;
      if (afterSeq !== null) {
        events = events.filter((event) => (num(event.seq) ?? -1) > afterSeq);
      }
      return {
        ok: true,
        sessionId,
        cursor: snapshot.cursor ?? -1,
        turn: summary.turn,
        running: summary.running,
        records: events.map(projectEvent) as unknown as Array<Record<string, unknown>>,
      };
    }),

    resolveApproval: wrapOp(async (params) => {
      const approvalId = typeof params.approvalId === "string" ? params.approvalId.trim() : "";
      if (!approvalId) return { ok: false, reason: "`approvalId` is required" };
      if (!approvals || typeof approvals.resolve !== "function") {
        return { ok: false, reason: "approvals store is unavailable" };
      }
      const mappedDecision =
        params.decision === "allow" || params.decision === "allow-once"
          ? "allow-once"
          : params.decision === "deny" || params.decision === "reject"
            ? "reject"
            : null;
      if (!mappedDecision) {
        return { ok: false, reason: `invalid approval decision "${String(params.decision)}"` };
      }
      const note = typeof params.note === "string" ? params.note : null;
      const outcome = approvals.resolve(approvalId, mappedDecision, note);
      if (!outcome?.resolved) {
        return { ok: false, reason: `no pending approval "${approvalId}"` };
      }
      return {
        ok: true,
        resolved: true,
        accepted: true,
        approvalId,
        sessionId: outcome.sessionId ?? null,
        toolName: outcome.toolName ?? null,
        decision: mappedDecision,
      };
    }),
  };
}

export interface StickyLock {
  tail: Promise<void>;
  waiters: number;
}

export interface StickyReservation {
  sessionId: string;
  cwd: string | null;
  inFlight: number;
}

export interface PreparedStickyOptions {
  target: { provider: string; model: string } | null;
  effort: string;
  permissionPreset: string;
}

interface AcquiredStickyReuse {
  sessionId: string;
  cwd: string | null;
  created: false;
  applied: { selected?: SelectedModel; permissionPreset?: string };
  stickyReservation: StickyReservation;
  stickyQueue: boolean;
  deferredOptions: boolean;
  optionPlan: PreparedStickyOptions | null;
}

interface AcquiredStickyCreate {
  sessionId: string;
  cwd: string | null;
  created: true;
  selected?: SelectedModel | undefined;
  permissionPreset?: string | undefined;
  rotatedEntry: { sessionId: string } | null;
  stickyReservation: StickyReservation;
  stickyQueue: false;
}

export type AcquiredStickyResult = AcquiredStickyReuse | AcquiredStickyCreate;

export interface PromptSlot {
  runId: string;
  done: Promise<void>;
  finish: () => void;
}

export interface LoggerLike {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
}

