// Which sessions did this bridge process create?
//
// The approval answerer must never speak for a session a human is watching in
// the GUI: answering there would race the human's own dialog, and a wrong
// "allowed-once" is not recoverable. Ownership is therefore the narrowest
// definition that is still useful — a session this process created through
// `dsh.sessions.create` or `dsh.sessions.ask`. Sessions from an earlier process
// stay unowned until this bridge creates them again, which only means the
// answerer stays silent for them; silence is the fail-closed direction.
//
// The set is bounded because a long-lived bridge could otherwise grow it
// forever: insertion order is creation order, so dropping the oldest entry
// forgets the least likely session to ask for an approval again.

const MAX_OWNED = 2_000;

const owned = new Map();

/** Remember that this process created `sessionId`. */
export function ownSession(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  owned.set(sessionId, Date.now());
  while (owned.size > MAX_OWNED) {
    const oldest = owned.keys().next().value;
    owned.delete(oldest);
  }
  return true;
}

/** Whether this process created the session (and may therefore answer for it). */
export function isOwnedSession(sessionId) {
  return typeof sessionId === "string" && owned.has(sessionId);
}

/** Drop a session (the Host may delete it while the bridge keeps running). */
export function forgetSession(sessionId) {
  return typeof sessionId === "string" ? owned.delete(sessionId) : false;
}

/** Current owned-session ids, oldest first. Diagnostics and tests only. */
export function ownedSessions() {
  return [...owned.keys()];
}

/** Count without materialising the list. */
export function ownedSessionCount() {
  return owned.size;
}

/** Test hook: forget everything. */
export function resetOwnedSessions() {
  owned.clear();
}
