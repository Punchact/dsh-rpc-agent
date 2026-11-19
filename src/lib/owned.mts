// Which sessions did this bridge create?
//
// The approval answerer must never speak for a session a human is watching in
// the GUI: answering there would race the human's own dialog, and a wrong
// "allowed-once" is not recoverable. Ownership is the narrowest definition that
// is still useful — a session this bridge created through `dsh.sessions.create`
// or `dsh.sessions.ask`.
//
// With approvals switched on the list is written down (see `approval-state.mjs`):
// a restart used to turn the gate off for every session the bridge had created,
// so unattended callers hung on a prompt nobody was watching. With approvals
// off nothing is written at all — ownership then only feeds diagnostics and the
// in-memory answerer, and an extra file on every session would be noise.
//
// Both backends are bounded: the persisted one caps how many sessions it
// remembers and drops the least recently touched first.

import { MAX_STATE_SESSIONS, createApprovalState, type ApprovalState } from "./approval-state.mjs";

export interface OwnedStoreOptions {
  file?: string;
}

interface OwnedBackendView {
  get(id: string): number | undefined;
  has(id: string): boolean;
  set(id: string): unknown;
  delete(id: string): boolean;
  keys(): string[];
  size(): number;
}

/** Persisted store injected by the plugin (approvals on), or null. */
let store: ApprovalState | null = null;
/** Fallback when approvals are off: process memory only, no file. */
const memory = new Map<string, number>();

/** Kept as a number for callers that reason about the cap. */
export const MAX_OWNED = MAX_STATE_SESSIONS;

/**
 * Point ownership at a specific state file (tests, or the plugin when it already
 * built one for the approval gate). Passing null returns to memory only.
 */
export function useOwnedState(state: ApprovalState | null | undefined): void {
  store = state ?? null;
}

/** Lazily created store for callers that did not inject one (tests). */
export function ownedStore({ file }: OwnedStoreOptions = {}): ApprovalState {
  if (!store) store = createApprovalState(file ? { file } : {});
  return store;
}

function backend(): OwnedBackendView {
  return store
    ? {
        get: (id: string) => store!.owned.get(id),
        has: (id: string) => store!.owned.has(id),
        set: (id: string) => store!.owned.set(id, Date.now()),
        delete: (id: string) => store!.owned.delete(id),
        keys: () => [...store!.owned.keys()],
        size: () => store!.owned.size,
      }
    : {
        get: (id: string) => memory.get(id),
        has: (id: string) => memory.has(id),
        set: (id: string) => {
          memory.set(id, Date.now());
        },
        delete: (id: string) => memory.delete(id),
        keys: () => [...memory.keys()],
        size: () => memory.size,
      };
}

/** Remember that this bridge created `sessionId`. */
export function ownSession(sessionId: unknown): boolean {
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  backend().set(sessionId);
  return true;
}

/** Whether this bridge created the session (and may therefore answer for it). */
export function isOwnedSession(sessionId: unknown): boolean {
  return typeof sessionId === "string" && sessionId.length > 0 && backend().has(sessionId);
}

/** Drop a session (the Host may delete it while the bridge keeps running). */
export function forgetSession(sessionId: unknown): boolean {
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  return backend().delete(sessionId);
}

/** Current owned-session ids, oldest first. Diagnostics and tests only. */
export function ownedSessions(): string[] {
  return backend().keys();
}

/** Count without materialising the list. */
export function ownedSessionCount(): number {
  return backend().size();
}

/** Test hook: forget everything (memory and, when injected, the journal). */
export function resetOwnedSessions(): void {
  const view = backend();
  for (const sessionId of view.keys()) view.delete(sessionId);
  memory.clear();
}
