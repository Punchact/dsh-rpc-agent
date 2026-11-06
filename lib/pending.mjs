// Pending escalations, waiting for whoever dispatched the work.
//
// `approvals.mode=delegate` turns an in-place sandbox escalation into a
// question for the caller: the gate holds the tool call, the caller reads the
// decision packet through `dsh.approvals.pending`, answers with
// `dsh.approvals.resolve`, and the gate either lets the call run (after
// widening the session's preset for that one call) or refuses it.
//
// Three properties matter more than the API shape:
//
//   1. Every pending entry expires. The Host's approval service has no timeout
//      of its own — that is how a turn sat on `approval/asked` for ten minutes
//      — so the deadline here is what turns "nobody answered" into a definite
//      answer instead of a hang. Expiry is a refusal, never an allowance.
//   2. Ids are unguessable. They travel in decision packets and come back
//      through `dsh.approvals.resolve`; a sequential counter would let anything
//      holding the same bearer token enumerate and answer other sessions'
//      escalations. `randomUUID()` keeps that from being a matter of guessing.
//   3. The store holds state a caller can inspect, not callbacks it can invoke.

import { randomUUID } from "node:crypto";

/** Hard ceiling on simultaneous pending entries; beyond it the oldest expires. */
export const MAX_PENDING = 32;

/**
 * @param {object} [options]
 * @param {number} [options.deadlineMs] how long an unanswered request waits
 * @param {() => number} [options.now] clock, injectable for tests
 * @param {{warn?: Function}} [options.log]
 */
export function createPendingStore({ deadlineMs = 60_000, now = Date.now, log } = {}) {
  const entries = new Map();
  const waiters = new Set();

  function notify() {
    for (const waiter of [...waiters]) {
      try {
        waiter();
      } catch {
        // A broken waiter must not stop the others.
      }
    }
  }

  function finish(entry, outcome) {
    if (entry.done) return false;
    entry.done = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.onAbort) entry.signal?.removeEventListener?.("abort", entry.onAbort);
    entries.delete(entry.approvalId);
    entry.settle(outcome);
    notify();
    return true;
  }

  /**
   * Register a question and return the promise the gate will await.
   *
   * @param {object} packet fields the caller needs to decide
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] the call being held; aborting it withdraws the question
   * @returns {{approvalId: string, packet: object, promise: Promise<{decision: string, note: string|null}>}}
   */
  function open(packet, { signal } = {}) {
    const approvalId = `apv-${randomUUID()}`;
    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    const createdAt = now();
    const entry = {
      approvalId,
      packet: { approvalId, ...packet, createdAt, expiresAt: createdAt + deadlineMs },
      settle,
      timer: null,
      done: false,
    };
    entries.set(approvalId, entry);

    // The call may already be cancelled when it reaches us — a listener added
    // afterwards never fires, and an entry nobody is waiting for could still be
    // approved later. Check the flag before arming anything.
    if (signal?.aborted === true) {
      log?.warn?.(`[dsh-rpc] approval ${approvalId} withdrawn on arrival: the call was already cancelled`);
      finish(entry, { decision: "cancelled", note: "the call was cancelled before it reached the gate" });
      return { approvalId, packet: entry.packet, promise };
    }

    entry.timer = setTimeout(() => {
      log?.warn?.(`[dsh-rpc] approval ${approvalId} expired after ${deadlineMs} ms; refusing the call`);
      finish(entry, { decision: "expired", note: null });
    }, deadlineMs);
    entry.timer.unref?.();

    // A held call can be cancelled (turn aborted, caller gone). Keep offering
    // it and the caller may "approve" a call nobody is waiting for any more.
    if (signal) {
      entry.signal = signal;
      entry.onAbort = () => {
        log?.warn?.(`[dsh-rpc] approval ${approvalId} withdrawn: the call was cancelled`);
        finish(entry, { decision: "cancelled", note: "the call was cancelled before an answer arrived" });
      };
      signal.addEventListener?.("abort", entry.onAbort, { once: true });
    }

    while (entries.size > MAX_PENDING) {
      const oldest = entries.keys().next().value;
      log?.warn?.(`[dsh-rpc] approval ${oldest} dropped: too many pending requests`);
      finish(entries.get(oldest), { decision: "expired", note: "dropped: too many pending requests" });
    }
    notify();
    return { approvalId, packet: entry.packet, promise };
  }

  /**
   * Answer a pending question.
   *
   * @param {string} approvalId
   * @param {"allow-once" | "reject"} decision
   * @param {string|null} [note]
   * @returns {{resolved: boolean, sessionId?: string, toolName?: string, decision?: string}}
   */
  function resolve(approvalId, decision, note = null) {
    const entry = entries.get(approvalId);
    if (!entry) return { resolved: false };
    const { sessionId, toolName } = entry.packet;
    const resolved = finish(entry, { decision, note });
    return { resolved, sessionId, toolName, decision };
  }

  /** @param {string} [sessionId] */
  function list(sessionId) {
    const out = [];
    for (const entry of entries.values()) {
      if (typeof sessionId === "string" && entry.packet.sessionId !== sessionId) continue;
      out.push({ ...entry.packet });
    }
    return out;
  }

  /**
   * Wait until at least one entry exists (or the wait expires).
   *
   * @param {object} [options]
   * @param {string} [options.sessionId]
   * @param {number} [options.waitMs]
   * @param {AbortSignal} [options.signal]
   */
  async function waitForAny({ sessionId, waitMs = 0, signal } = {}) {
    const immediate = list(sessionId);
    if (immediate.length > 0 || waitMs <= 0) return { pending: immediate, timedOut: immediate.length === 0 };
    const budget = Math.min(Math.max(Math.trunc(waitMs), 0), 120_000);
    return new Promise((resolveResult) => {
      let done = false;
      let timer = null;

      const settle = (timedOut) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        waiters.delete(check);
        signal?.removeEventListener?.("abort", onAbort);
        resolveResult({ pending: list(sessionId), timedOut });
      };
      const check = () => {
        if (list(sessionId).length > 0) settle(false);
      };
      const onAbort = () => settle(true);
      waiters.add(check);
      timer = setTimeout(() => settle(true), budget);
      timer.unref?.();
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }

  return {
    open,
    resolve,
    list,
    waitForAny,
    size: () => entries.size,
    deadlineMs,
  };
}
