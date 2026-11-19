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

export const APPROVAL_DECISIONS = Object.freeze(["allow-once", "reject"] as const);
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const PENDING_OUTCOMES = Object.freeze([
  "allow-once",
  "reject",
  "expired",
  "cancelled",
] as const);
export type PendingOutcome = (typeof PENDING_OUTCOMES)[number];

export const PENDING_STATES = Object.freeze(["pending", ...PENDING_OUTCOMES] as const);
export type PendingApprovalState = (typeof PENDING_STATES)[number];

export const PENDING_TRANSITIONS: Readonly<Record<PendingApprovalState, readonly PendingOutcome[]>> = Object.freeze<
  Record<PendingApprovalState, readonly PendingOutcome[]>
>({
  pending: Object.freeze(["allow-once", "reject", "expired", "cancelled"]),
  "allow-once": Object.freeze([]),
  reject: Object.freeze([]),
  expired: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export interface PendingApprovalPacket {
  approvalId: string;
  sessionId?: string;
  toolName?: string;
  callId?: string;
  escalation?: unknown;
  argv?: unknown;
  cwd?: string | null;
  preset?: string | null;
  reason?: string | null;
  createdAt: number;
  expiresAt: number;
  [key: string]: unknown;
}

export interface PendingResolutionOutcome {
  decision: PendingOutcome | string;
  note: string | null;
}

export interface PendingOpenOptions {
  signal?: AbortSignal;
}

export interface PendingOpenResult {
  approvalId: string;
  packet: PendingApprovalPacket;
  promise: Promise<PendingResolutionOutcome>;
}

export interface PendingResolveResult {
  resolved: boolean;
  sessionId?: string;
  toolName?: string;
  decision?: ApprovalDecision | string;
}

export interface PendingWaitOptions {
  sessionId?: string;
  waitMs?: number;
  signal?: AbortSignal | null;
}

export interface PendingWaitResult {
  pending: PendingApprovalPacket[];
  timedOut: boolean;
  aborted?: boolean;
}

export interface PendingWatchResult {
  promise: Promise<PendingApprovalPacket>;
  cancel: () => void;
}

export interface PendingStoreLogger {
  warn?: (message: string) => void;
}

export interface CreatePendingStoreOptions {
  deadlineMs?: number;
  now?: () => number;
  log?: PendingStoreLogger | null;
}

export interface PendingStore {
  open(packet: Record<string, unknown>, options?: PendingOpenOptions): PendingOpenResult;
  open(...args: any[]): PendingOpenResult;
  resolve(
    approvalId: string,
    decision: ApprovalDecision | string,
    note?: string | null,
  ): PendingResolveResult;
  list(sessionId?: string): PendingApprovalPacket[];
  waitForAny(options?: PendingWaitOptions): Promise<PendingWaitResult>;
  watch(sessionId: string): PendingWatchResult;
  size(): number;
  readonly deadlineMs: number;
  cancelAll?: () => void;
}

interface PendingEntry {
  approvalId: string;
  packet: PendingApprovalPacket;
  settle: (outcome: PendingResolutionOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function createPendingStore({
  deadlineMs = 60_000,
  now = Date.now,
  log,
}: CreatePendingStoreOptions = {}): PendingStore {
  const entries = new Map<string, PendingEntry>();
  const waiters = new Set<() => void>();

  function notify(): void {
    for (const waiter of [...waiters]) {
      try {
        waiter();
      } catch {
        // A broken waiter must not stop the others.
      }
    }
  }

  function finish(entry: PendingEntry | undefined, outcome: PendingResolutionOutcome): boolean {
    if (!entry || entry.done) return false;
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
   */
  function open(packet: Record<string, unknown>, { signal }: PendingOpenOptions = {}): PendingOpenResult {
    const approvalId = `apv-${randomUUID()}`;
    let settle!: (outcome: PendingResolutionOutcome) => void;
    const promise = new Promise<PendingResolutionOutcome>((resolvePromise) => {
      settle = resolvePromise;
    });
    const createdAt = now();
    const entry: PendingEntry = {
      approvalId,
      packet: { ...packet, approvalId, createdAt, expiresAt: createdAt + deadlineMs },
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
      const oldest = entries.keys().next().value as string;
      log?.warn?.(`[dsh-rpc] approval ${oldest} dropped: too many pending requests`);
      finish(entries.get(oldest), { decision: "expired", note: "dropped: too many pending requests" });
    }
    notify();
    return { approvalId, packet: entry.packet, promise };
  }

  /**
   * Answer a pending question.
   */
  function resolve(
    approvalId: string,
    decision: ApprovalDecision | string,
    note: string | null = null,
  ): PendingResolveResult {
    const entry = entries.get(approvalId);
    if (!entry) return { resolved: false };
    const { sessionId, toolName } = entry.packet;
    const resolved = finish(entry, { decision, note });
    return { resolved, sessionId, toolName, decision };
  }

  function list(sessionId?: string): PendingApprovalPacket[] {
    const out: PendingApprovalPacket[] = [];
    for (const entry of entries.values()) {
      if (typeof sessionId === "string" && entry.packet.sessionId !== sessionId) continue;
      out.push({ ...entry.packet });
    }
    return out;
  }

  /**
   * Wait until at least one entry exists (or the wait expires).
   */
  async function waitForAny({ sessionId, waitMs = 0, signal }: PendingWaitOptions = {}): Promise<PendingWaitResult> {
    const immediate = list(sessionId);
    // A caller whose own call was cancelled is not going to answer anything;
    // resolving "timed out" at once keeps it from sitting out the whole budget.
    if (signal?.aborted === true) return { pending: immediate, timedOut: true, aborted: true };
    if (immediate.length > 0 || waitMs <= 0) return { pending: immediate, timedOut: immediate.length === 0 };
    const budget = Math.min(Math.max(Math.trunc(waitMs), 0), 120_000);
    return new Promise<PendingWaitResult>((resolveResult) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const settle = (timedOut: boolean): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        waiters.delete(check);
        signal?.removeEventListener?.("abort", onAbort);
        resolveResult({ pending: list(sessionId), timedOut });
      };
      const check = (): void => {
        if (list(sessionId).length > 0) settle(false);
      };
      const onAbort = (): void => settle(true);
      waiters.add(check);
      timer = setTimeout(() => settle(true), budget);
      timer.unref?.();
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }

  /**
   * Resolve as soon as this session has a question to answer.
   *
   * The turn loop needs this and cannot use `waitForAny`: while `wait()` holds the
   * turn, the caller is blocked inside its own tool call and has no chance to ask
   * `dsh.approvals.pending`, so the deadline would always expire first. Racing the
   * stream against this promise lets the turn hand back "I am blocked on an
   * approval" while the approval is still open.
   */
  function watch(sessionId: string): PendingWatchResult {
    let resolveWatch!: (packet: PendingApprovalPacket) => void;
    const promise = new Promise<PendingApprovalPacket>((resolvePromise) => {
      resolveWatch = resolvePromise;
    });
    let active = true;
    const check = (): void => {
      if (!active) return;
      const found = list(sessionId);
      if (found.length === 0) return;
      active = false;
      waiters.delete(check);
      resolveWatch(found[0]);
    };
    waiters.add(check);
    check();
    return {
      promise,
      cancel(): void {
        if (!active) return;
        active = false;
        waiters.delete(check);
      },
    };
  }

  return {
    open,
    resolve,
    list,
    waitForAny,
    watch,
    size: () => entries.size,
    deadlineMs,
  };
}
