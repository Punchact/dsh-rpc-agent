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

/**
 * Mask credential-shaped assignments anywhere inside a value. Key-based masking
 * alone is not enough — a payload can smuggle `Authorization: Bearer …` through
 * a harmless looking key — and text substitution alone is not enough either,
 * because a nested object under a sensitive key keeps its children.
 */
function scrubValue(text) {
  return text.replace(
    /((?:token|secret|password|passwd|api[-_]?key|authorization|cookie)\s*[=:]\s*(?:bearer\s+|basic\s+)?\\?['"]?)([^\s"',;}\\]+)/gi,
    (_match, head) => `${head}[redacted]`,
  );
}

function redactValue(value, depth = 0) {
  if (depth > 8) return "[redacted: too deep]";
  if (typeof value === "string") return scrubValue(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * A decision packet is what the caller decides on, so it has to carry the whole
 * call: a `write_file` that hides its payload in `content` must not look like
 * an empty command.
 *
 * `argv` is a *view* of `args`, never a shortcut around it: both are redacted
 * and both are bounded, so a long or secret-bearing command cannot skip the
 * masking that `args` gets.
 *
 * @param {unknown} args parsed tool arguments
 * @returns {{argv: string, args: string, truncated: boolean}}
 */
export function describeArgs(args) {
  if (!args || typeof args !== "object") return { argv: "", args: "", truncated: false };
  let json = "";
  try {
    json = JSON.stringify(redactValue(args)) ?? "";
  } catch {
    json = "";
  }
  const safe = scrubValue(json);
  const truncated = safe.length > MAX_ARGV_CHARS;
  const clipped = truncated
    ? `${safe.slice(0, MAX_ARGV_CHARS)}… (truncated ${safe.length - MAX_ARGV_CHARS} of ${safe.length} chars)`
    : safe;
  const command = typeof args.command === "string" ? scrubValue(args.command) : "";
  const target = typeof args.path === "string" ? scrubValue(args.path) : "";
  const shorthand = command || target;
  const argv =
    shorthand.length > MAX_ARGV_CHARS
      ? `${shorthand.slice(0, MAX_ARGV_CHARS)}… (truncated ${shorthand.length - MAX_ARGV_CHARS} of ${shorthand.length} chars)`
      : shorthand;
  return { argv: argv || clipped, args: clipped, truncated };
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
 * A call held back only because the session is mid-widening. It is a refusal for
 * this call, but not an escalation decision: nothing about it is counted.
 */
function holdDecision({ toolName, why }) {
  const reason = `the dsh-rpc bridge held "${toolName}" back for a moment; ${why}`;
  return { kind: "deny", reason, info: { name: DENIED_ERROR_NAME, code: DENIED_ERROR_CODE, reason } };
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
  state = null,
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
    return createApprovalGate({ mode: "deny", isOwned, onDeny, state, log });
  }

  /**
   * sessionId → escalations won so far. Reserved before the caller is asked.
   * Backed by the on-disk journal when one is supplied: a restart must not hand
   * the session a fresh allowance.
   */
  const allowances = state?.allowances ?? new Map();
  /**
   * sessionId → the preset to put back once the approved call has run. Also the
   * durable record that the Host may still be wide: whatever is left here at the
   * next start is put back by `recover()`.
   */
  const widened = state?.widened ?? new Map();
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

  /** One key per (session, call): a bare call id is not unique across sessions. */
  function restoreKey(sessionId, callId) {
    return `${sessionId}\u0000${callId}`;
  }

  function claim(exec) {
    const sessionId = exec?.agent?.session?.id;
    // Ownership is the whole basis for answering on someone else's behalf, so
    // it is checked before anything else — including before trusting the id.
    // A missing `isOwned` is *not* a reason to answer for everybody: without a
    // way to tell our sessions from a human's, the gate stays silent.
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    if (typeof isOwned !== "function") {
      log?.warn?.("[dsh-rpc] approvals are configured but no ownership test was supplied; the gate stays silent");
      return null;
    }
    if (!isOwned(sessionId)) return null;
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

    // A widened session is wide for *every* call, not only the approved one, so a
    // call that asks for nothing would inherit an escalation it never requested.
    // It waits its turn: the window closes when the approved call ends.
    if (target.escalation === "") {
      if (widened.has(target.sessionId)) {
        log?.warn?.(
          `[dsh-rpc] held ${target.toolName} in ${target.sessionId}: the session is widened for an approved call`,
        );
        return holdDecision({
          toolName: target.toolName,
          why: "This session is temporarily widened for an approved call; retry once it finishes.",
        });
      }
      return pass();
    }

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

    // Checked before the allowance so the caller is told the truth: with one
    // allowance left, a call racing the approved one must not be told the
    // session is out of allowances when what it really has to do is wait.
    if (widened.has(target.sessionId)) {
      refuse(target, "another escalated call is already running in this session");
      return denyDecision({
        escalation: target.escalation,
        toolName: target.toolName,
        why: "Another escalated call is already running in this session; retry after it finishes.",
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

    // Without a call id nothing can tell when the call is over, so an approval
    // could not be tied to it — and restoring before the tool runs would spend
    // the allowance on a call that never gets the escalation. Refuse up front,
    // before anybody is asked.
    if (!target.callId) {
      rollback(target);
      refuse(target, "the tool call carries no call id, so an approval could not be tied to it");
      return denyDecision({
        escalation: target.escalation,
        toolName: target.toolName,
        why: "This call cannot be tied to an approval (no call id), so the bridge will not widen the session for it.",
      });
    }

    // Mark the session as occupied *before* the caller is asked. Holding only the
    // answer would let every escalation in the same tick open its own question,
    // and a caller that approves one would find five waiting for it.
    // The preset to put back has to be the one that is really there. Guessing
    // would either leave a read-only session widened, or "restore" a session to
    // a preset it never had.
    const previous = readPreset(target.sessionId);
    if (previous === null) {
      rollback(target);
      refuse(target, "the session's current preset is not readable, so it could not be put back afterwards");
      return denyDecision({
        escalation: target.escalation,
        toolName: target.toolName,
        why: "The bridge cannot read this session's current preset, so it cannot promise to restore it.",
      });
    }
    widened.set(target.sessionId, previous);

    const described = describeArgs(exec?.arguments);
    // The justification is the agent's own prose: it is masked like any other
    // value the agent controls, and clipped, before it reaches a caller.
    const justification =
      typeof exec?.arguments?.sandbox_justification === "string"
        ? scrubValue(exec.arguments.sandbox_justification).slice(0, MAX_REASON_CHARS)
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
    // nothing runs, so the session must not be left widened. A listener that
    // throws is the same situation with an escaping error — the preset has to be
    // put back *before* the error leaves this function, otherwise the session
    // stays wide and `widened` keeps the session blocked forever.
    let downstream;
    try {
      downstream = await pass();
    } catch (error) {
      await restore();
      rollback(target);
      throw error;
    }
    if (downstream?.kind !== "allow") {
      await restore();
      rollback(target);
      return downstream;
    }

    // Keyed by session *and* call: two sessions can use the same call id
    // (`call-1` is a common shape), and a shared key would let one session's
    // completion restore the other's preset while its call is still running.
    const key = restoreKey(target.sessionId, target.callId);
    const timer = setTimeout(() => {
      restores.delete(key);
      void restore();
    }, RESTORE_FALLBACK_MS);
    timer.unref?.();
    restores.set(key, { restore, timer });

    try {
      onAllow?.({ sessionId: target.sessionId, toolName: target.toolName, callId: target.callId, escalation: target.escalation });
    } catch {
      // Accounting must never change the answer.
    }
    log?.info?.(`[dsh-rpc] caller allowed ${target.escalation} for ${target.sessionId} (${approvalId})`);
    return downstream;
  };

  /**
   * `tools/post-execute` is a four-argument waterfall:
   *
   *   (exec, result, next) => Promise<PostToolDecision>
   *
   * The decision MUST be returned — a listener that returns `undefined` makes the
   * registry read `.kind` of it, and every tool call in the process dies with
   * "Cannot read properties of undefined (reading 'kind')". That is exactly what
   * happened in 0.7.5: this handler was written as `(exec, next)`, so it treated
   * the *result* as the continuation, never called it, and returned undefined.
   */
  const post = async function restoreAfterRun(exec, result, next) {
    const callId = typeof exec?.callId === "string" ? exec.callId : "";
    const sessionId = exec?.agent?.session?.id;
    const key = callId && typeof sessionId === "string" ? restoreKey(sessionId, callId) : "";
    const entry = key ? restores.get(key) : undefined;
    if (entry) {
      restores.delete(key);
      clearTimeout(entry.timer);
    }
    // `finally`: a result handler that throws must not be able to keep the
    // session wide. Restoring is the point of this listener, not a trailing step.
    try {
      return typeof next === "function" ? await next() : { kind: "accept" };
    } finally {
      if (entry) await entry.restore();
    }
  };

  /**
   * Put every widened session back and stop the fallback timers. Registered from
   * the plugin's `ctx.effect`: a reload or shutdown must not leave a session
   * running wide with nothing left to restore it.
   */
  async function dispose() {
    for (const [, entry] of [...restores]) {
      clearTimeout(entry.timer);
      await entry.restore();
    }
    restores.clear();
    for (const [sessionId, previous] of [...widened]) {
      widened.delete(sessionId);
      try {
        await applyPreset?.(sessionId, previous);
        log?.info?.(`[dsh-rpc] restored ${sessionId} to ${previous} on shutdown`);
      } catch (error) {
        log?.warn?.(`[dsh-rpc] could not restore ${sessionId} on shutdown: ${error?.message ?? String(error)}`);
      }
    }
  }

  // A gate that breaks must never break the tools it sits in front of. Every
  // failure inside a listener degrades to "this gate does not exist": the call is
  // passed through untouched. 0.7.5 shipped without this, and one wrong arity in
  // `post` took down every tool call in the Host.
  const guarded = (listener, whenBroken) => async function guardedListener(...args) {
    try {
      return await listener(...args);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      log?.warn?.("[dsh-rpc] approval gate failed, passing the call through: " + message);
      return whenBroken(...args);
    }
  };

  const passThrough = (exec, next) => (typeof next === "function" ? next() : Promise.resolve({ kind: "allow" }));
  const acceptThrough = (exec, result, next) =>
    typeof next === "function" ? next() : Promise.resolve({ kind: "accept" });

  /**
   * Put back presets this bridge left wide in an earlier life.
   *
   * `dispose` cannot run when the process is killed, so the journal is the only
   * record that a session may still be widened. Best effort: a session the Host
   * no longer has is forgotten, and the entry is dropped either way so a
   * permanently broken restore cannot be retried on every start.
   */
  async function recover() {
    const pending = typeof state?.pendingWidens === "function" ? state.pendingWidens() : [];
    if (pending.length === 0) return { restored: 0, failed: 0 };
    let restored = 0;
    let failed = 0;
    for (const { sessionId, previous } of pending) {
      try {
        if (typeof applyPreset === "function") await applyPreset(sessionId, previous);
        widened.delete(sessionId);
        restored += 1;
        log?.info?.(`[dsh-rpc] put ${sessionId} back to "${previous}" after an unclean stop`);
      } catch (error) {
        failed += 1;
        widened.delete(sessionId);
        log?.warn?.(
          `[dsh-rpc] could not put ${sessionId} back to "${previous}" (${error?.message ?? error}); check that session's preset`,
        );
      }
    }
    return { restored, failed };
  }

  return {
    pre: guarded(pre, passThrough),
    post: guarded(post, acceptThrough),
    dispose,
    recover,
    widenedSessions: () => [...widened.keys()],
  };

}
