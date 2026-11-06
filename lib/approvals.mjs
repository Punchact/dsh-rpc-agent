// The escalation gate: who says "no" — or "yes" — when a bridge-owned session
// hits the sandbox wall?
//
// A session this bridge created has no human attached. The Host's approval
// service fails closed on its own — a missing answerer yields `'unavailable'`
// — but "no answerer" is indistinguishable from "nobody noticed yet", and the
// tool call waits on that promise until its signal aborts. Measured on a live
// session: the turn sat on `approval/asked` for ten minutes and produced
// nothing.
//
// The obvious seam — `ctx.on("approval/request", …)` — does not work for
// sessions we did not compose. The approval service dispatches through
// `scopeTarget(req.agent, req.agent)`, and that filter reaches only answerers
// inside the agent's own composition; a listener registered on this plugin's
// context, or even on the root context, is never called. Verified by
// instrumenting a reply build and watching a real escalation: the listener
// registered, and was never invoked, while the GUI kept the dialog open.
//
// What does reach every agent is `tools/pre-execute`, a global waterfall that
// runs before dispatch (`dsh-experimental-auto-review` uses the same seam for
// its per-call review). So the gate lives there.
//
//   off       — never register; the Host's own path applies.
//   deny      — refuse in-place escalation from bridge-owned sessions. It only
//               ever takes privilege away.
//   delegate  — hold the call and ask the dispatching agent, through
//               `dsh.approvals.pending` / `dsh.approvals.resolve`. No answer
//               within `approvals.deadlineMs` means refusal, never assent.
//
// `allow-once` means one call, not one session. The gate widens the session's
// preset only long enough for the approved call to run, then puts the previous
// preset back from `tools/post-execute` (a safety timer restores it even if the
// tool never reports). Widening permanently would turn "approve this command"
// into "approve everything this session will ever do", which is a different and
// much larger decision than the one the caller was asked to make.
//
// Only bridge-owned sessions are ever touched: every session a human is
// watching in the GUI keeps its own answerer.

export const APPROVAL_MODES = ["off", "deny", "delegate"];

/**
 * Escalations this gate is willing to forward. `danger-full-access` is the one
 * step the Host's own ladder documents (`workspace-write` may only go there),
 * and `workspace-write` is the one step up from `read-only`. Anything else is
 * refused without asking, so a caller can never be talked into a mode the
 * deployment does not offer.
 */
export const ESCALATION_TARGETS = ["workspace-write", "danger-full-access"];

/** How many escalations one session may win, ever. Delegation is not a grant. */
export const MAX_ALLOWANCES_PER_SESSION = 3;

/** How much of the tool's arguments the decision packet carries. */
export const MAX_ARGV_CHARS = 4_000;

/** How much of the agent's own justification survives into the packet. */
export const MAX_REASON_CHARS = 500;

/** Give up on `tools/post-execute` and put the preset back anyway. */
const RESTORE_FALLBACK_MS = 5 * 60_000;

const DENIED_ERROR_NAME = "DshRpcApprovalDenied";
const DENIED_ERROR_CODE = "APPROVAL_DENIED_BY_BRIDGE";

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|credential|authorization|cookie)/i;

/**
 * Read the escalation a pending call is asking for, if any. `sandbox_permissions`
 * is the argument the shell tools use to request a wider sandbox; its absence
 * means the call is not asking for one.
 *
 * A value we cannot read as a mode is reported verbatim rather than ignored:
 * the whitelist below then refuses it. Silently treating an unreadable request
 * as "no escalation" would fail open on exactly the calls worth looking at.
 *
 * @param {unknown} args parsed tool arguments
 * @returns {string} the requested mode, "" when this is not an escalation
 */
export function escalationOf(args) {
  if (!args || typeof args !== "object") return "";
  if (!Object.hasOwn(args, "sandbox_permissions")) return "";
  const requested = args.sandbox_permissions;
  if (requested === undefined || requested === null || requested === "") return "";
  if (typeof requested === "string") return requested.trim();
  try {
    return `non-string:${JSON.stringify(requested)}`;
  } catch {
    return `non-string:${typeof requested}`;
  }
}

/** Mask the values of arguments that look like credentials. */
function redact(text) {
  const byKey = text.replace(
    /("([^"\\]*(?:\\.[^"\\]*)*)"\s*:\s*)("(?:[^"\\]|\\.)*"|\[[^\]]*\]|[^,}\s]+)/g,
    (match, head, key, value) => (SECRET_KEY.test(key) ? `${head}"[redacted]"` : match),
  );
  // A payload can smuggle credentials through a harmless-looking key
  // (`content: "curl -H 'Authorization: Bearer ...'"`), so values are scrubbed
  // for credential-shaped assignments as well.
  return byKey.replace(
    /((?:token|secret|password|passwd|api[-_]?key|authorization|cookie)\s*[=:]\s*)([^\s"',;}]+)/gi,
    (_match, head) => `${head}[redacted]`,
  );
}

/**
 * A decision packet is what the caller decides on, so it has to carry the whole
 * call: a `write_file` that hides its payload in `content` must not look like
 * an empty command.
 *
 * @param {unknown} args parsed tool arguments
 * @returns {{argv: string, args: string, truncated: boolean}}
 */
export function describeArgs(args) {
  if (!args || typeof args !== "object") return { argv: "", args: "", truncated: false };
  const command = typeof args.command === "string" ? args.command : "";
  const target = typeof args.path === "string" ? args.path : "";
  let json = "";
  try {
    json = JSON.stringify(args) ?? "";
  } catch {
    json = "";
  }
  const safe = redact(json);
  const truncated = safe.length > MAX_ARGV_CHARS;
  const clipped = truncated
    ? `${safe.slice(0, MAX_ARGV_CHARS)}… (truncated ${safe.length - MAX_ARGV_CHARS} of ${safe.length} chars)`
    : safe;
  return { argv: command || target || clipped, args: clipped, truncated };
}

function denyDecision({ escalation, toolName, why }) {
  const reason =
    `the dsh-rpc bridge refused a sandbox escalation to "${escalation}" for tool "${toolName}"; ` +
    `the call was not executed. ${why}`;
  return {
    kind: "deny",
    reason,
    info: { name: DENIED_ERROR_NAME, code: DENIED_ERROR_CODE, reason },
  };
}

/**
 * Build the two listeners the bridge registers. `pre` decides; `post` puts a
 * widened preset back once the approved call has run.
 *
 * @param {object} options
 * @param {"off"|"deny"|"delegate"} options.mode
 * @param {(sessionId: string) => boolean} options.isOwned
 * @param {(info: object) => void} [options.onDeny]
 * @param {(info: object) => void} [options.onAllow]
 * @param {(sessionId: string, preset: string) => Promise<void>} [options.applyPreset]
 * @param {(sessionId: string) => string|null} [options.currentPreset]
 * @param {object} [options.store] pending-approval store (delegate only)
 * @param {{info?: Function, warn?: Function}} [options.log]
 * @returns {{pre: Function, post: Function, widenedSessions: () => string[]} | null}
 */
export function createApprovalGate({
  mode,
  isOwned,
  onDeny,
  onAllow,
  applyPreset,
  currentPreset,
  store,
  log,
} = {}) {
  if (mode === "off") return null;
  if (!APPROVAL_MODES.includes(mode)) {
    log?.warn?.(`[dsh-rpc] approvals.mode "${mode}" is not one of ${APPROVAL_MODES.join(", ")}; approvals stay off`);
    return null;
  }
  const delegating = mode === "delegate";
  if (delegating && (!store || typeof store.open !== "function" || typeof applyPreset !== "function")) {
    log?.warn?.(
      "[dsh-rpc] approvals.mode \"delegate\" needs the pending store and the preset setter; falling back to deny",
    );
    return createApprovalGate({ mode: "deny", isOwned, onDeny, log });
  }

  /** sessionId → escalations won so far. Reserved before the caller is asked. */
  const allowances = new Map();
  /** sessionId → the preset to put back once the approved call has run. */
  const widened = new Map();
  /** callId → how to undo the widening. */
  const restores = new Map();

  function readPreset(sessionId) {
    try {
      const value = currentPreset?.(sessionId);
      return typeof value === "string" && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  function rollback(target) {
    const used = allowances.get(target.sessionId) ?? 0;
    if (used <= 1) allowances.delete(target.sessionId);
    else allowances.set(target.sessionId, used - 1);
  }

  function claim(exec) {
    const sessionId = exec?.agent?.session?.id;
    // Ownership is the whole basis for answering on someone else's behalf, so
    // it is checked before anything else — including before trusting the id.
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    if (typeof isOwned === "function" && !isOwned(sessionId)) return null;
    return {
      sessionId,
      toolName: typeof exec?.name === "string" ? exec.name : "unknown",
      callId: typeof exec?.callId === "string" ? exec.callId : "",
      session: exec?.agent?.session ?? null,
      escalation: escalationOf(exec?.arguments),
    };
  }

  function refuse(target, why) {
    try {
      onDeny?.({ sessionId: target.sessionId, toolName: target.toolName, callId: target.callId, escalation: target.escalation });
    } catch {
      // Accounting must never change the answer.
    }
    log?.info?.(`[dsh-rpc] refused a sandbox escalation to ${target.escalation} for ${target.toolName} in ${target.sessionId}: ${why}`);
  }

  const pre = async function gateEscalation(exec, next) {
    const pass = typeof next === "function" ? next : () => Promise.resolve({ kind: "allow" });
    const target = claim(exec);
    if (!target) return pass();
    if (target.escalation === "") return pass();

    if (!ESCALATION_TARGETS.includes(target.escalation)) {
      refuse(target, `"${target.escalation}" is not a documented escalation`);
      return denyDecision({
        escalation: target.escalation,
        toolName: target.toolName,
        why: `Only ${ESCALATION_TARGETS.join(" and ")} may be requested.`,
      });
    }

    if (!delegating) {
      refuse(target, "approvals.mode is \"deny\"");
      return denyDecision({
        escalation: target.escalation,
        toolName: target.toolName,
        why: "This bridge refuses sandbox escalations: nobody is attached to this session to approve one.",
      });
    }

    const used = allowances.get(target.sessionId) ?? 0;
    if (used >= MAX_ALLOWANCES_PER_SESSION) {
      refuse(target, `${used} escalations already granted in this session (limit ${MAX_ALLOWANCES_PER_SESSION})`);
      return denyDecision({
        escalation: target.escalation,
        toolName: target.toolName,
        why: `This session already used its ${MAX_ALLOWANCES_PER_SESSION} delegated escalations.`,
      });
    }

    // Reserve before asking. Two calls in the same tick would otherwise both
    // read `used` and both spend the same allowance.
    allowances.set(target.sessionId, used + 1);

    if (widened.has(target.sessionId)) {
      rollback(target);
      refuse(target, "another escalated call is already running in this session");
      return denyDecision({
        escalation: target.escalation,
        toolName: target.toolName,
        why: "Another escalated call is already running in this session; retry after it finishes.",
      });
    }

    // Mark the session as occupied *before* the caller is asked. Holding only the
    // answer would let every escalation in the same tick open its own question,
    // and a caller that approves one would find five waiting for it.
    const previous = readPreset(target.sessionId) ?? "workspace-write";
    widened.set(target.sessionId, previous);

    const described = describeArgs(exec?.arguments);
    const justification = typeof exec?.arguments?.sandbox_justification === "string"
      ? exec.arguments.sandbox_justification.slice(0, MAX_REASON_CHARS)
      : null;

    const { approvalId, packet, promise } = store.open(
      {
        sessionId: target.sessionId,
        toolName: target.toolName,
        callId: target.callId,
        escalation: target.escalation,
        argv: described.argv,
        args: described.args,
        argsTruncated: described.truncated,
        cwd: target.session?.header?.cwd ?? target.session?.meta?.cwd ?? null,
        preset: readPreset(target.sessionId),
        reason: justification,
        // The justification is the agent's own prose. It is carried so a human
        // can see what was claimed, never as a reason to allow something.
        untrusted: true,
      },
      { signal: exec?.signal },
    );
    log?.info?.(
      `[dsh-rpc] holding ${target.toolName} in ${target.sessionId}: approval ${approvalId} asks the caller ` +
        `to allow ${target.escalation}`,
    );

    const answer = await promise;
    if (answer.decision !== "allow-once") {
      widened.delete(target.sessionId);
      rollback(target);
      refuse(target, `the caller did not allow it (${answer.decision}${answer.note ? `: ${answer.note}` : ""})`);
      return denyDecision({
        escalation: target.escalation,
        toolName: target.toolName,
        why:
          answer.decision === "expired"
            ? "The caller did not answer within the deadline, and an unanswered escalation is a refusal."
            : `The caller answered "${answer.decision}"${answer.note ? `: ${answer.note}` : ""}.`,
      });
    }

    try {
      await applyPreset(target.sessionId, target.escalation);
    } catch (error) {
      widened.delete(target.sessionId);
      rollback(target);
      refuse(target, `widening the preset failed: ${error?.message ?? String(error)}`);
      return denyDecision({
        escalation: target.escalation,
        toolName: target.toolName,
        why: "The caller approved it, but the bridge could not widen this session's sandbox.",
      });
    }

    const restore = async () => {
      widened.delete(target.sessionId);
      try {
        await applyPreset(target.sessionId, previous);
        log?.info?.(`[dsh-rpc] restored ${target.sessionId} to ${previous} (${approvalId})`);
      } catch (error) {
        log?.warn?.(`[dsh-rpc] could not restore ${target.sessionId} to ${previous}: ${error?.message ?? String(error)}`);
      }
    };

    // Ask the rest of the waterfall first: if a later listener refuses the call,
    // nothing runs, so the session must not be left widened.
    const downstream = await pass();
    if (downstream?.kind !== "allow") {
      await restore();
      rollback(target);
      return downstream;
    }

    if (target.callId) {
      const timer = setTimeout(() => {
        restores.delete(target.callId);
        void restore();
      }, RESTORE_FALLBACK_MS);
      timer.unref?.();
      restores.set(target.callId, { restore, timer });
    } else {
      // No call id means no way to know when the call is over; restore at once
      // rather than leave the session wide for an unknown period.
      await restore();
    }

    try {
      onAllow?.({ sessionId: target.sessionId, toolName: target.toolName, callId: target.callId, escalation: target.escalation });
    } catch {
      // Accounting must never change the answer.
    }
    log?.info?.(`[dsh-rpc] caller allowed ${target.escalation} for ${target.sessionId} (${approvalId})`);
    return downstream;
  };

  const post = async function restoreAfterRun(exec, next) {
    const callId = typeof exec?.callId === "string" ? exec.callId : "";
    const entry = callId ? restores.get(callId) : undefined;
    if (entry) {
      restores.delete(callId);
      clearTimeout(entry.timer);
    }
    const result = typeof next === "function" ? await next() : undefined;
    if (entry) await entry.restore();
    return result;
  };

  return { pre, post, widenedSessions: () => [...widened.keys()] };
}
