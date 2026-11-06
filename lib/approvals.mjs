// The escalation gate: who says "no" when a bridge-owned session hits the
// sandbox wall?
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
// its per-call review). So `deny` is a pre-execute gate: when a session this
// bridge created asks to widen its own sandbox, the gate refuses the call
// before it turns into an unanswered prompt.
//
//   off   — never register the gate; the Host's own path applies.
//   deny  — refuse in-place escalation from bridge-owned sessions. It only
//           ever takes privilege away: a call that does not ask for more
//           sandbox is untouched, and sessions this bridge did not create —
//           including every session a human is watching in the GUI — are left
//           to their own answerer.
//
// `delegate` (ask the dispatching agent) stays a later phase: it needs a
// pending/resolve API and a deadline, and `deny` already removes the failure
// this bridge actually suffered.

export const APPROVAL_MODES = ["off", "deny"];

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

/**
 * Build the `tools/pre-execute` gate, or `null` when the mode asks for silence.
 * The returned function follows the Host's waterfall contract: return a
 * decision to claim the call, or call `next()` to let it proceed.
 *
 * @param {object} options
 * @param {string} [options.mode] one of {@link APPROVAL_MODES}
 * @param {(sessionId: unknown) => boolean} [options.isOwned]
 * @param {(decision: {sessionId: string, toolName: string, callId: string|null, escalation: string}) => void} [options.onDeny]
 * @param {{info?: Function, warn?: Function}} [options.log]
 */
export function createApprovalGate({ mode = "off", isOwned, onDeny, log } = {}) {
  if (mode === "off") return null;
  if (mode !== "deny") {
    // Config validation rejects unknown modes, so reaching here means a caller
    // constructed this by hand. Staying silent is the safe direction.
    log?.warn?.(`[dsh-rpc] unknown approvals.mode "${String(mode)}"; the escalation gate stays silent`);
    return null;
  }

  return function denyEscalation(exec, next) {
    const delegate = typeof next === "function" ? next : () => Promise.resolve({ kind: "allow" });
    const sessionId = exec?.agent?.session?.id;
    // Require a readable id before consulting ownership: an owner test that
    // answers `true` for `undefined` must not be able to widen this claim.
    if (typeof sessionId !== "string" || sessionId.length === 0) return delegate();
    if (typeof isOwned !== "function" || !isOwned(sessionId)) return delegate();

    const escalation = escalationOf(exec?.arguments);
    if (escalation === "") return delegate();

    const toolName = typeof exec?.name === "string" && exec.name.length > 0 ? exec.name : "?";
    const callId = typeof exec?.callId === "string" ? exec.callId : null;
    try {
      onDeny?.({ sessionId, toolName, callId, escalation });
    } catch {
      // Accounting must never change the answer.
    }
    log?.info?.(
      `[dsh-rpc] refused a sandbox escalation to ${escalation} for ${toolName} in ${sessionId}: ` +
        "approvals.mode=deny, and a session this bridge created has no one to answer the prompt",
    );
    return {
      kind: "deny",
      reason:
        `approvals.mode=deny refused a sandbox escalation to "${escalation}" for tool "${toolName}"; ` +
        "the call was not executed. This session was started by the dsh-rpc bridge and has no human to " +
        "answer an approval prompt — finish the turn without that permission, or ask the caller to rerun " +
        "the work with a wider permission preset",
      info: {
        name: DENIED_ERROR_NAME,
        code: DENIED_ERROR_CODE,
        reason: `escalation to "${escalation}" refused by the bridge (approvals.mode=deny)`,
      },
    };
  };
}
