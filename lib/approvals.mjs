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

const DENIED_ERROR_NAME = "DshRpcApprovalDenied";
const DENIED_ERROR_CODE = "APPROVAL_DENIED_BY_BRIDGE";

/**
 * Read the escalation a pending call is asking for, if any. `sandbox_permissions`
 * is the argument the shell tools use to request a wider sandbox; its absence
 * means the call is not asking for one.
 *
 * @param {unknown} args parsed tool arguments
 * @returns {string} the requested mode, or "" when this is not an escalation
 */
export function escalationOf(args) {
  const requested = args?.sandbox_permissions;
  return typeof requested === "string" ? requested.trim() : "";
}

/** The command line a caller needs in order to judge the request. */
function argvOf(args) {
  if (typeof args?.command === "string") return args.command;
  if (typeof args?.path === "string") return args.path;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "";
  }
}

function denyDecision({ escalation, toolName, why }) {
  return {
    kind: "deny",
    reason:
      `the dsh-rpc bridge refused a sandbox escalation to "${escalation}" for tool "${toolName}"; ` +
      `the call was not executed. ${why}`,
    info: {
      name: DENIED_ERROR_NAME,
      code: DENIED_ERROR_CODE,
      reason: `escalation to "${escalation}" refused by the bridge (${why})`,
    },
  };
}

/**
 * Build the `tools/pre-execute` gate, or `null` when the mode asks for silence.
 * The returned function follows the Host's waterfall contract: return a
 * decision to claim the call, or call `next()` to let it proceed.
 *
 * @param {object} options
 * @param {string} [options.mode] one of {@link APPROVAL_MODES}
 * @param {(sessionId: unknown) => boolean} [options.isOwned]
 * @param {(event: object) => void} [options.onDeny] accounting for a refusal
 * @param {(event: object) => void} [options.onAllow] accounting for a grant
 * @param {(sessionId: string, escalation: string) => Promise<string>|string} [options.applyPreset]
 * @param {ReturnType<import("./pending.mjs").createPendingStore>} [options.store]
 * @param {(key: string) => unknown} [options.sessionField] reads cwd/preset off the session
 * @param {{info?: Function, warn?: Function}} [options.log]
 */
export function createApprovalGate({
  mode = "off",
  isOwned,
  onDeny,
  onAllow,
  applyPreset,
  store,
  log,
} = {}) {
  if (mode === "off") return null;
  if (mode !== "deny" && mode !== "delegate") {
    // Config validation rejects unknown modes, so reaching here means a caller
    // constructed this by hand. Staying silent is the safe direction.
    log?.warn?.(`[dsh-rpc] unknown approvals.mode "${String(mode)}"; the escalation gate stays silent`);
    return null;
  }
  if (mode === "delegate" && (typeof store?.open !== "function" || typeof applyPreset !== "function")) {
    log?.warn?.("[dsh-rpc] approvals.mode=delegate needs a pending store and a preset applier; falling back to deny");
    mode = "deny";
  }

  const allowances = new Map();

  /** Shared guards; returns the fields to work with, or null when not ours. */
  function claim(exec) {
    const sessionId = exec?.agent?.session?.id;
    // Require a readable id before consulting ownership: an owner test that
    // answers `true` for `undefined` must not be able to widen this claim.
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    if (typeof isOwned !== "function" || !isOwned(sessionId)) return null;
    const escalation = escalationOf(exec?.arguments);
    if (escalation === "") return null;
    const toolName = typeof exec?.name === "string" && exec.name.length > 0 ? exec.name : "?";
    const callId = typeof exec?.callId === "string" ? exec.callId : null;
    return { sessionId, escalation, toolName, callId, session: exec?.agent?.session };
  }

  function refuse(target, why) {
    try {
      onDeny?.({ sessionId: target.sessionId, toolName: target.toolName, callId: target.callId, escalation: target.escalation });
    } catch {
      // Accounting must never change the answer.
    }
    log?.info?.(
      `[dsh-rpc] refused a sandbox escalation to ${target.escalation} for ${target.toolName} in ` +
        `${target.sessionId}: approvals.mode=${mode}, ${why}`,
    );
  }

  if (mode === "deny") {
    return function denyEscalation(exec, next) {
      const delegate = typeof next === "function" ? next : () => Promise.resolve({ kind: "allow" });
      const target = claim(exec);
      if (!target) return delegate();
      refuse(target, "and a session this bridge created has no one to answer the prompt");
      return denyDecision({
        escalation: target.escalation,
        toolName: target.toolName,
        why:
          "This session was started by the dsh-rpc bridge and has no human to answer an approval " +
          "prompt — finish the turn without that permission, or ask the caller to rerun the work " +
          "with a wider permission preset",
      });
    };
  }

  return async function delegateEscalation(exec, next) {
    const pass = typeof next === "function" ? next : () => Promise.resolve({ kind: "allow" });
    const target = claim(exec);
    if (!target) return pass();

    if (!ESCALATION_TARGETS.includes(target.escalation)) {
      refuse(target, `"${target.escalation}" is not a documented escalation`);
      return denyDecision({
        escalation: target.escalation,
        toolName: target.toolName,
        why: `Only ${ESCALATION_TARGETS.join(" and ")} may be requested.`,
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

    const { approvalId, promise } = store.open({
      sessionId: target.sessionId,
      toolName: target.toolName,
      callId: target.callId,
      escalation: target.escalation,
      argv: argvOf(exec?.arguments),
      cwd: target.session?.header?.cwd ?? target.session?.meta?.cwd ?? null,
      preset: target.session?.permissionPreset ?? null,
      reason: typeof exec?.arguments?.sandbox_justification === "string" ? exec.arguments.sandbox_justification : null,
    });
    log?.info?.(
      `[dsh-rpc] holding ${target.toolName} in ${target.sessionId}: approval ${approvalId} asks the caller ` +
        `to allow ${target.escalation}`,
    );

    const answer = await promise;
    if (answer.decision === "allow-once") {
      try {
        await applyPreset(target.sessionId, target.escalation);
      } catch (error) {
        refuse(target, `widening the preset failed: ${error?.message ?? String(error)}`);
        return denyDecision({
          escalation: target.escalation,
          toolName: target.toolName,
          why: "The caller approved it, but the bridge could not widen this session's sandbox.",
        });
      }
      allowances.set(target.sessionId, used + 1);
      try {
        onAllow?.({ sessionId: target.sessionId, toolName: target.toolName, callId: target.callId, escalation: target.escalation });
      } catch {
        // Accounting must never change the answer.
      }
      log?.info?.(`[dsh-rpc] caller allowed ${target.escalation} for ${target.sessionId} (${approvalId})`);
      return pass();
    }

    refuse(target, `the caller did not allow it (${answer.decision}${answer.note ? `: ${answer.note}` : ""})`);
    return denyDecision({
      escalation: target.escalation,
      toolName: target.toolName,
      why:
        answer.decision === "expired"
          ? "The caller did not answer within the deadline, and an unanswered escalation is a refusal."
          : `The caller answered "${answer.decision}"${answer.note ? `: ${answer.note}` : ""}.`,
    });
  };
}
