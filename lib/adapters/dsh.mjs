// DSH baseline runtime adapter (§8.2): bridges the task hub's 7-operation
// adapter contract onto injected DSH session ops with zero HTTP or host coupling.
//
// Operation mapping table:
//   probe()           -> ops.sessionStatus({ probe: true })        (read-only, never creates a session)
//   start(req)        -> ops.createSession(...) -> ops.askSession(...) -> locator { kind: "dsh", sessionId }
//   inspect(loc)      -> ops.sessionStatus({ sessionId })          -> 6-state reportOf(...)
//   events(loc, cur)  -> ops.sessionHistory({ sessionId, afterSeq: cur }) -> { events, nextCursor: history.cursor }
//   sendInput(loc, x) -> ops.promptSession({ sessionId, text, mode: "steer" })
//   cancel(loc)       -> ops.cancelSession({ sessionId })          -> { requestAccepted, stopped: res.stopped === true }
//   decideApproval()  -> ops.resolveApproval({ approvalId, decision, note })

import { TASK_ERROR, taskError, validationFailed } from "../tasks/errors.mjs";
import { ADAPTER_FAILURE_MESSAGES, reportOf, validateAdapter } from "./base.mjs";
import { redactDeep, redactSecrets } from "./redact.mjs";

const REQUIRED_OPS = Object.freeze([
  "createSession",
  "askSession",
  "promptSession",
  "cancelSession",
  "sessionStatus",
  "sessionHistory",
  "resolveApproval",
]);

// Only a *request* can block on a human. DSH also writes `approval/policy` (the session's
// approval policy at start, e.g. `{ policy: "ask" }`) and resolution rows such as
// `approval/resolved`; treating every `approval/*` record as "waiting for the operator"
// parked a finished task in `waiting_input` behind a question nobody could answer
// (0.9.0 live run, 2026-11-19). The authoritative "is anything pending?" answer stays with
// the session-status path, so an unclassified approval row is reported as progress.
const BLOCKING_APPROVAL_KINDS = Object.freeze(new Set(["requested", "request"]));

function extractLocatorAndArg(arg1, arg2) {
  if (arg2 && typeof arg2 === "object" && (arg2.sessionId || arg2.locator || arg2.kind === "dsh")) {
    return arg2.locator ?? arg2;
  }
  if (arg1 && typeof arg1 === "object") {
    return arg1.locator ?? arg1;
  }
  return {};
}

function extractSessionId(locator, fallback) {
  const id = locator?.sessionId ?? fallback?.sessionId;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : "";
}

function assertOpOk(res, fallbackMessage, details = {}) {
  if (!res || res.ok === false) {
    const err = taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, details);
    Object.defineProperty(err, "internalDetail", {
      value: res?.reason || fallbackMessage,
      enumerable: false,
    });
    throw err;
  }
  return res;
}

function normalizeApprovalAttention(pending, fallbackPrompt = "approval required") {
  const approvalId =
    typeof pending?.approvalId === "string" && pending.approvalId.trim()
      ? pending.approvalId.trim()
      : null;
  const toolName =
    typeof pending?.toolName === "string" && pending.toolName.trim() ? pending.toolName.trim() : null;
  const rawPrompt =
    (typeof pending?.prompt === "string" && pending.prompt.trim()) ||
    (typeof pending?.summary === "string" && pending.summary.trim()) ||
    (toolName ? `Approval required for tool "${toolName}"` : fallbackPrompt);
  const prompt = redactSecrets(rawPrompt, { maxChars: 2000 }) ?? fallbackPrompt;

  return {
    kind: "approval",
    prompt,
    ...(approvalId ? { approvalId, questionId: approvalId } : {}),
    ...(toolName ? { toolName } : {}),
  };
}

function statusToReport(sessionId, st) {
  if (st.pendingApproval || st.status === "waiting_approval") {
    return reportOf("blocked", {
      observedStatus: st.status ?? "waiting_approval",
      attention: normalizeApprovalAttention(st.pendingApproval ?? st, "session waiting for approval"),
      reason: redactSecrets(st.reason, { maxChars: 2000 }) ?? "session is waiting for operator approval",
      evidence: {
        sessionId,
        pendingApproval: st.pendingApproval ? redactDeep(st.pendingApproval, { maxChars: 2000 }) : null,
      },
    });
  }

  if (st.running === true || st.status === "running") {
    return reportOf("progress", {
      observedStatus: st.status ?? "running",
      ...(st.turn !== undefined ? { turn: st.turn } : {}),
      evidence: {
        sessionId,
        running: true,
        ...(st.turn !== undefined ? { turn: st.turn } : {}),
      },
    });
  }

  if (st.status === "completed" || st.status === "ready" || st.status === "idle") {
    // Honest reporting rule: completion observed from status without a
    // schema-validated result must keep `resultValid: false`.
    return reportOf("ready", {
      observedStatus: st.status,
      resultValid: false,
      reason: "session reported completed without a validated task result",
      evidence: {
        sessionId,
        ...(st.turn !== undefined ? { turn: st.turn } : {}),
      },
    });
  }

  if (st.status === "failed" || st.status === "error") {
    const safeError = redactSecrets(st.error, { maxChars: 2000 });
    const safeReason = safeError ?? redactSecrets(st.reason, { maxChars: 2000 }) ?? "session failed";
    return reportOf("failed", {
      observedStatus: st.status,
      failureClass: st.failureClass ?? "runtime_error",
      reason: safeReason,
      evidence: {
        sessionId,
        ...(safeError ? { error: safeError } : {}),
      },
    });
  }

  if (st.status === "cancelled" || st.status === "canceled" || st.status === "aborted") {
    return reportOf("dropped", {
      droppedBy: "cancelled",
      observedStatus: st.status,
      reason: redactSecrets(st.reason, { maxChars: 2000 }) ?? "session cancelled",
      evidence: { sessionId },
    });
  }

  return reportOf("blocked", {
    observedStatus: String(st.status ?? "unknown"),
    failureClass: "unknown_status",
    reason:
      redactSecrets(st.reason, { maxChars: 2000 }) ??
      `unrecognized DSH session status: ${String(st.status ?? "unknown")}`,
    evidence: { sessionId, rawStatus: st.status ?? null },
  });
}

function recordToReport(sessionId, record) {
  const type = typeof record?.type === "string" ? record.type : "unknown";
  const seq = record?.seq ?? record?.cursor ?? 0;
  const data = record?.data && typeof record.data === "object" ? record.data : {};
  const adapterEventId = `${sessionId}:${seq}:${type}`;

  if (type === "turn/end") {
    const reason = data.reason ?? record?.reason ?? null;
    const redactedReasonObj = reason !== null ? redactDeep(reason, { maxChars: 2000 }) : null;
    const redactedReasonMsg = redactSecrets(reason?.message, { maxChars: 2000 });
    const status = reason?.kind ?? data.status ?? record?.status ?? "completed";
    if (status === "failed" || status === "error" || status === "aborted_error") {
      return {
        adapterEventId,
        report: reportOf("failed", {
          observedType: type,
          observedStatus: status,
          failureClass: "runtime_error",
          reason: redactedReasonMsg ?? "DSH turn ended with failure",
          evidence: { sessionId, seq, reason: redactedReasonObj },
        }),
      };
    }
    if (status === "cancelled" || status === "canceled" || status === "aborted" || status === "interrupted") {
      return {
        adapterEventId,
        report: reportOf("dropped", {
          droppedBy: "cancelled",
          observedType: type,
          observedStatus: status,
          reason: redactedReasonMsg ?? "DSH turn cancelled",
          evidence: { sessionId, seq, reason: redactedReasonObj },
        }),
      };
    }
    const hasValidatedResult = data.resultValid === true && data.result !== undefined && data.result !== null;
    return {
      adapterEventId,
      report: reportOf("ready", {
        observedType: type,
        observedStatus: status,
        ...(hasValidatedResult ? { result: data.result, resultValid: true } : { resultValid: false }),
        reason: hasValidatedResult
          ? "turn ended with validated result"
          : "turn ended without validated task result",
        evidence: { sessionId, seq, reason: redactedReasonObj },
      }),
    };
  }

  if (type.startsWith("approval/")) {
    const rawReason = data.summary ?? data.prompt;
    const approvalKind = type.slice("approval/".length);
    if (!BLOCKING_APPROVAL_KINDS.has(approvalKind)) {
      return {
        adapterEventId,
        report: reportOf("progress", {
          observedType: type,
          observedStatus: approvalKind,
          reason:
            redactSecrets(rawReason, { maxChars: 2000 }) ??
            `approval event (${type}) records no pending decision`,
          evidence: {
            sessionId,
            seq,
            type,
            approvalId: data.approvalId ?? record?.approvalId ?? null,
            ...(data.policy !== undefined ? { policy: data.policy } : {}),
          },
        }),
      };
    }
    return {
      adapterEventId,
      report: reportOf("blocked", {
        observedType: type,
        attention: normalizeApprovalAttention(
          {
            approvalId: data.approvalId ?? record?.approvalId,
            toolName: data.toolName ?? record?.toolName,
            prompt: data.prompt ?? data.summary ?? record?.prompt,
          },
          `Approval event (${type}) requires operator decision`,
        ),
        reason: redactSecrets(rawReason, { maxChars: 2000 }) ?? `approval event: ${type}`,
        evidence: { sessionId, seq, type, approvalId: data.approvalId ?? record?.approvalId ?? null },
      }),
    };
  }

  if (type === "tool/result" && (data.isError === true || record?.isError === true)) {
    const rawErr = data.error ?? data.message;
    return {
      adapterEventId,
      report: reportOf("progress", {
        observedType: type,
        toolError: true,
        reason: redactSecrets(rawErr, { maxChars: 2000 }) ?? "tool returned error",
        evidence: {
          sessionId,
          seq,
          isError: true,
          toolName: data.toolName ?? null,
          detail: redactDeep(data, { maxChars: 2000 }),
        },
      }),
    };
  }

  return {
    adapterEventId,
    report: reportOf("progress", {
      observedType: type,
      evidence: { sessionId, seq, type },
    }),
  };
}

/**
 * Create the DSH baseline adapter over injected session ops.
 */
export function createDshAdapter({ ops, now = Date.now } = {}) {
  if (!ops || typeof ops !== "object" || Array.isArray(ops)) {
    throw taskError(TASK_ERROR.INVALID_ADAPTER, "createDshAdapter requires an `ops` object");
  }
  for (const name of REQUIRED_OPS) {
    if (typeof ops[name] !== "function") {
      throw taskError(TASK_ERROR.INVALID_ADAPTER, `createDshAdapter missing required op "${name}"`, {
        missingOp: name,
      });
    }
  }

  const adapter = {
    kind: "dsh",

    async probe() {
      const startedAt = now();
      try {
        // Probe stays strictly read-only and never invokes createSession/askSession.
        const res = await ops.sessionStatus({ probe: true });
        if (!res || res.ok === false) {
          return {
            ok: false,
            reason: ADAPTER_FAILURE_MESSAGES.unavailable,
            elapsedMs: Math.max(0, now() - startedAt),
          };
        }
        return {
          ok: true,
          elapsedMs: Math.max(0, now() - startedAt),
          controls: {
            start: true,
            steer: true,
            cancel: true,
            inspect: true,
            approval: true,
            events: true,
          },
        };
      } catch {
        return {
          ok: false,
          reason: ADAPTER_FAILURE_MESSAGES.unavailable,
          elapsedMs: Math.max(0, now() - startedAt),
        };
      }
    },

    async start(arg1, arg2) {
      const req = arg2 ?? arg1 ?? {};
      const task = req.task ?? {};
      const agent = req.agent ?? {};
      const workspace = req.workspace ?? {};
      const summary = task.requestSummary ?? task.request_summary ?? {};
      const adapterConfig = agent.adapterConfig ?? agent.adapter_config ?? {};

      const cwd = req.cwd ?? workspace.rootPath ?? workspace.root_path ?? summary.cwd ?? adapterConfig.cwd;
      const agentPreset = req.agentPreset ?? summary.agentPreset ?? adapterConfig.agentPreset;
      const model = req.model ?? summary.model ?? adapterConfig.model;
      const reasoningEffort = req.reasoningEffort ?? summary.reasoningEffort ?? adapterConfig.reasoningEffort;
      const permissionPreset = req.permissionPreset ?? summary.permissionPreset ?? adapterConfig.permissionPreset;

      const created = assertOpOk(
        await ops.createSession({
          ...(cwd ? { cwd } : {}),
          ...(agentPreset ? { agentPreset } : {}),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(permissionPreset ? { permissionPreset } : {}),
        }),
        "ops.createSession failed",
      );

      const sessionId = typeof created.sessionId === "string" ? created.sessionId.trim() : "";
      if (!sessionId) {
        throw taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, {
          reason: "missing_session_id",
        });
      }

      const promptText =
        req.prompt ??
        req.text ??
        summary.prompt ??
        summary.text ??
        summary.input?.prompt ??
        summary.input?.text ??
        (summary.input !== undefined ? JSON.stringify(summary.input) : "");

      assertOpOk(
        await ops.askSession({
          sessionId,
          prompt: String(promptText),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(permissionPreset ? { permissionPreset } : {}),
        }),
        "ops.askSession failed",
        { sessionId },
      );

      return {
        accepted: true,
        // Never include host endpoints, tokens, or secrets in persisted locators.
        locator: { kind: "dsh", sessionId },
      };
    },

    async inspect(arg1, arg2) {
      const locator = extractLocatorAndArg(arg1, arg2);
      const sessionId = extractSessionId(locator, arg1);
      if (!sessionId) {
        throw validationFailed("locator.sessionId is required for inspect", { field: "sessionId" });
      }
      const st = assertOpOk(await ops.sessionStatus({ sessionId }), "ops.sessionStatus failed", { sessionId });
      // The same observed state must carry the same id, otherwise every poll looks like
      // a brand-new report to the ledger. A real state change still produces a new id.
      const stateKey = [st.status ?? "unknown", st.running === true ? "running" : "idle", st.turn ?? "-"].join(":");
      return {
        report: statusToReport(sessionId, st),
        adapterEventId: `status:${sessionId}:${stateKey}`,
      };
    },

    async sendInput(arg1, arg2, arg3) {
      const locator = arg3 !== undefined ? (arg2?.locator ?? arg2) : extractLocatorAndArg(arg1, undefined);
      const inputObj = arg3 !== undefined ? arg3 : arg2 !== undefined ? arg2 : arg1;
      const sessionId = extractSessionId(locator, arg1);
      if (!sessionId) {
        throw validationFailed("locator.sessionId is required for sendInput", { field: "sessionId" });
      }
      const text = typeof inputObj === "string" ? inputObj : (inputObj?.text ?? inputObj?.prompt ?? "");
      const res = assertOpOk(
        await ops.promptSession({ sessionId, text: String(text), mode: "steer" }),
        "ops.promptSession failed",
        { sessionId },
      );
      return {
        accepted: res.accepted !== false,
        sessionId,
        mode: "steer",
        ...(res.requestId ? { requestId: res.requestId } : {}),
      };
    },

    async cancel(arg1, arg2) {
      const locator = arg2?.locator ?? arg1?.locator ?? arg2 ?? arg1 ?? {};
      const sessionId = extractSessionId(locator, arg1);
      if (!sessionId) {
        throw validationFailed("locator.sessionId is required for cancel", { field: "sessionId" });
      }
      const reason = typeof arg2?.reason === "string" ? arg2.reason : typeof arg1?.reason === "string" ? arg1.reason : undefined;
      const res = assertOpOk(
        await ops.cancelSession({ sessionId, ...(reason ? { reason } : {}) }),
        "ops.cancelSession failed",
        { sessionId },
      );
      return {
        requestAccepted: res.accepted !== false,
        // Only claim `stopped: true` when the underlying runtime explicitly confirms stop.
        stopped: res.stopped === true,
        // The dispatcher needs the confirmed form too: a task whose session never emits
        // another event would otherwise sit in cancel_requested forever.
        confirmedStopped: res.stopped === true,
        sessionId,
      };
    },

    async events(arg1, arg2, arg3) {
      let locator;
      let cursor;
      if (arg3 !== undefined) {
        locator = arg2?.locator ?? arg2;
        cursor = arg3;
      } else if (arg2 !== undefined && (typeof arg2 === "number" || typeof arg2 === "string" || arg2 === null)) {
        locator = arg1?.locator ?? arg1;
        cursor = arg2;
      } else if (arg2 && typeof arg2 === "object") {
        locator = arg2.locator ?? arg2;
        cursor = arg2.cursor ?? arg1?.cursor;
      } else {
        locator = arg1?.locator ?? arg1;
        cursor = arg1?.cursor;
      }

      const sessionId = extractSessionId(locator, arg1);
      if (!sessionId) {
        throw validationFailed("locator.sessionId is required for events", { field: "sessionId" });
      }

      const hist = assertOpOk(
        await ops.sessionHistory({
          sessionId,
          ...(cursor !== undefined && cursor !== null ? { afterSeq: cursor } : {}),
        }),
        "ops.sessionHistory failed",
        { sessionId },
      );

      const records = Array.isArray(hist.records) ? hist.records : [];
      const mapped = records.map((rec) => recordToReport(sessionId, rec));

      return {
        events: mapped,
        // Preserve cursor strictly as reported by history without inventing one.
        nextCursor: hist.cursor,
      };
    },

    async decideApproval(arg1, arg2, arg3) {
      const locator = arg3 !== undefined ? (arg2?.locator ?? arg2) : extractLocatorAndArg(arg1, undefined);
      const decisionObj = arg3 !== undefined ? arg3 : arg2 !== undefined ? arg2 : arg1;
      const sessionId = extractSessionId(locator, arg1);
      const approvalId =
        typeof decisionObj?.approvalId === "string" ? decisionObj.approvalId.trim() : "";
      if (!approvalId) {
        throw validationFailed("`approvalId` is required for decideApproval", { field: "approvalId" });
      }

      const note = decisionObj.note ?? decisionObj.reason;
      const res = assertOpOk(
        await ops.resolveApproval({
          ...(sessionId ? { sessionId } : {}),
          approvalId,
          decision: decisionObj.decision,
          ...(note !== undefined ? { note } : {}),
        }),
        "ops.resolveApproval failed",
        { approvalId },
      );

      return {
        accepted: res.accepted !== false && res.resolved !== false,
        approvalId,
        ...(sessionId ? { sessionId } : {}),
        ...(res.decision ? { decision: res.decision } : {}),
      };
    },
  };

  return validateAdapter(adapter);
}
