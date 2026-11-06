// The approval answerer: who decides when a bridge-owned session hits the
// sandbox wall?
//
// A session this bridge created has no human attached. The Host's approval
// service fails closed on its own — a missing answerer yields `'unavailable'`
// — but "no answerer" is indistinguishable from "nobody noticed yet", and the
// tool call waits on that promise until its signal aborts. In practice the
// turn hangs (measured: the kimi audit sat on `approval/asked` for ten
// minutes) and the caller learns nothing.
//
// So the bridge answers for its own sessions, in this order of intent:
//   off   — never register a listener; the Host's fail-closed path applies.
//   deny  — answer `'rejected'` immediately, so the model is told "no" and can
//           finish the turn with a report of what it could not do. It only
//           ever takes privilege away; a human watching the GUI keeps their
//           dialog because ownership excludes their sessions.
//
// `delegate` (ask the dispatching agent, default in the design document) is a
// later phase: it needs a pending/resolve API and a deadline, and `deny`
// already fixes the failure this bridge actually suffered.

export const APPROVAL_MODES = ["off", "deny"];

/**
 * Build the `approval/request` listener, or `null` when the mode asks for
 * silence. The returned function follows the Host's waterfall contract: claim
 * the request by returning an outcome, or call `next()` to delegate.
 *
 * @param {object} options
 * @param {string} [options.mode] one of {@link APPROVAL_MODES}
 * @param {(sessionId: unknown) => boolean} [options.isOwned]
 * @param {(decision: {sessionId: string, toolName: string, callId: string|null}) => void} [options.onDeny]
 * @param {{info?: Function, warn?: Function}} [options.log]
 */
export function createApprovalResponder({ mode = "off", isOwned, onDeny, log } = {}) {
  if (mode === "off") return null;
  if (mode !== "deny") {
    // Config validation rejects unknown modes, so reaching here means a caller
    // constructed this by hand. Staying silent is the safe direction.
    log?.warn?.(`[dsh-rpc] unknown approvals.mode "${String(mode)}"; the approval answerer stays silent`);
    return null;
  }

  return function respondToApproval(request, next) {
    const delegate = typeof next === "function" ? next : () => Promise.resolve("unavailable");
    const sessionId = request?.agent?.session?.id;
    // Require a readable id before consulting ownership: an owner test that
    // answers `true` for `undefined` must not be able to widen this claim.
    if (typeof sessionId !== "string" || sessionId.length === 0) return delegate();
    if (typeof isOwned !== "function" || !isOwned(sessionId)) return delegate();

    const toolName = typeof request?.toolName === "string" && request.toolName.length > 0 ? request.toolName : "?";
    const callId = typeof request?.callId === "string" ? request.callId : null;
    try {
      onDeny?.({ sessionId, toolName, callId });
    } catch {
      // Accounting must never change the answer.
    }
    log?.info?.(
      `[dsh-rpc] denied an approval for ${toolName} in ${sessionId}: ` +
        "approvals.mode=deny, and a session this bridge created has no human to answer for it",
    );
    return "rejected";
  };
}
