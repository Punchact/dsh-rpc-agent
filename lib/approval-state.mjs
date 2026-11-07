// The bridge's own memory about sessions, written down.
//
// Two things here are not conveniences but obligations:
//
//   * **allowances** — "this session has already won three escalations" has to
//     survive a restart, otherwise a restart is a free refill of the policy the
//     approval gate exists to enforce.
//   * **widened** — `allow-once` changes the *Host's* preset. If the bridge dies
//     between that change and the restore, the session stays wide with nothing
//     left to put it back. Reading this journal at startup is the only way the
//     bridge can notice it owes the Host a restore.
//
// Ownership is persisted too, because a restart otherwise silently turns the
// gate off for every session this bridge created (`owned.mjs` explains why
// silence is the safe direction, and it still is — but "safe" here means
// "unattended callers hang until their deadline", so remembering is better than
// forgetting).
//
// Deliberate properties, mirroring `registry.mjs`:
//   * one small JSON file, read once at startup and rewritten on change — the
//     writes are rare (a session is created, an escalation is granted), so a
//     synchronous atomic write is cheaper than a cache to invalidate;
//   * atomic replace (`.tmp` + rename) and 0600, so a crash mid-write cannot
//     leave a half-parsed file that would lose every allowance;
//   * a corrupt or unreadable file degrades to "nothing remembered" instead of
//     throwing: losing the memory must never fail the call that needed it;
//   * before every write the file is re-read and merged by `updatedAt`, so two
//     bridges writing the same file cannot silently lower a counter.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateDir } from "./auth.mjs";

export const APPROVAL_STATE_VERSION = 1;

/** Forget a session nobody has touched for this long. */
export const STATE_TTL_MS = 7 * 24 * 60 * 60_000;

/** Hard cap on remembered sessions; the least recently touched go first. */
export const MAX_STATE_SESSIONS = 2_000;

export function approvalStatePath(env = process.env) {
  return join(stateDir(env), "approvals.json");
}

function emptyState() {
  return { version: APPROVAL_STATE_VERSION, sessions: {} };
}

function normalizeReservations(value) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const [id, status] of Object.entries(value)) {
    if (typeof id === "string" && id.length > 0 && ["pending", "committed", "refunded"].includes(status)) result[id] = status;
  }
  return result;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitize(input, now) {
  const state = emptyState();
  if (!isRecord(input) || !isRecord(input.sessions)) return state;
  const entries = [];
  for (const [sessionId, record] of Object.entries(input.sessions)) {
    if (typeof sessionId !== "string" || sessionId.length === 0 || !isRecord(record)) continue;
    const updatedAt = Number.isFinite(record.updatedAt) ? record.updatedAt : 0;
    const reservations = normalizeReservations(record.reservations);
    const legacyUsed = Object.keys(reservations).length === 0 && Number.isInteger(record.used) && record.used > 0 ? record.used : 0;
    const baseUsed = Number.isInteger(record.baseUsed) && record.baseUsed > 0 ? record.baseUsed : legacyUsed;
    const used = Math.max(baseUsed, Object.values(reservations).filter((status) => status !== "refunded").length);
    const widenedTo = typeof record.widenedTo === "string" && record.widenedTo.length > 0 ? record.widenedTo : null;
    // An obligation (a session that may still be wide) is kept regardless of
    // age: the whole point is to restore it on the next start.
    if (!widenedTo && now - updatedAt > STATE_TTL_MS) continue;
    entries.push([
      sessionId,
      {
        used,
        owned: record.owned === true,
        widenedTo,
        updatedAt,
        rev: Number.isInteger(record.rev) ? record.rev : 0,
        baseUsed,
        reservations,
      },
    ]);
  }
  const obligations = entries.filter(([, record]) => record.widenedTo);
  const ordinary = entries.filter(([, record]) => !record.widenedTo).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  for (const [sessionId, record] of [...obligations, ...ordinary.slice(0, Math.max(0, MAX_STATE_SESSIONS - obligations.length))]) {
    state.sessions[sessionId] = record;
  }
  return state;
}

/**
 * Merge a freshly-read file into memory, field by field.
 *
 * Whole-record last-writer-wins is wrong for every field here except the journal:
 * a concurrent write must not refund an allowance (the counter may only err
 * upward), must not take ownership away, and must not resurrect a preset the
 * local process just put back. So: counts take the maximum, ownership is sticky,
 * and only `widenedTo` follows the newer record (ties favour memory, which is
 * the value this process just wrote).
 */
function mergeReservations(left = {}, right = {}) {
  const merged = { ...left };
  const rank = { pending: 0, refunded: 1, committed: 2 };
  for (const [id, status] of Object.entries(right)) {
    if (!(id in merged) || rank[status] > rank[merged[id]]) merged[id] = status;
  }
  return merged;
}

function mergeInto(memory, disk) {
  for (const [sessionId, incoming] of Object.entries(disk.sessions)) {
    const held = memory.sessions[sessionId];
    if (!held) {
      memory.sessions[sessionId] = incoming;
      continue;
    }
    const heldRev = held.rev ?? 0;
    const incomingRev = incoming.rev ?? 0;
    const incomingNewer =
      incoming.updatedAt > held.updatedAt || (incoming.updatedAt === held.updatedAt && incomingRev > heldRev);
    const reservations = mergeReservations(held.reservations, incoming.reservations);
    memory.sessions[sessionId] = {
      baseUsed: Math.max(held.baseUsed ?? held.used, incoming.baseUsed ?? incoming.used),
      used: Math.max(
        Math.max(held.baseUsed ?? held.used, incoming.baseUsed ?? incoming.used),
        Object.values(reservations).filter((status) => status !== "refunded").length,
      ),
      owned: held.owned || incoming.owned,
      widenedTo: incomingNewer ? incoming.widenedTo : held.widenedTo,
      updatedAt: Math.max(held.updatedAt, incoming.updatedAt),
      rev: Math.max(heldRev, incomingRev),
      reservations,
    };
  }
  return memory;
}

/**
 * @param {object} [options]
 * @param {string} [options.file] Path of the state file (defaults to $DSH_HOME/dsh-rpc/approvals.json).
 * @param {(message: string) => void} [options.log] Called on a degraded read or write.
 * @param {() => number} [options.now] Clock, for tests.
 */
export function createApprovalState({ file = approvalStatePath(), log = null, now = () => Date.now() } = {}) {
  let state = loadFrom(file, log, now());

  function loadFrom(path, logger, stamp) {
    try {
      return sanitize(JSON.parse(readFileSync(path, "utf8")), stamp);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logger?.warn?.(`[dsh-rpc] approval state at ${path} is unreadable (${error?.message ?? error}); starting empty`);
      }
      return emptyState();
    }
  }

  function write() {
    // Read-merge-write: the other bridge may have spent an allowance since this
    // process last wrote, and lowering a counter is exactly the failure the file
    // is meant to prevent.
    state = mergeInto(state, loadFrom(file, null, now()));
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(tmp, file);
      try {
        chmodSync(file, 0o600);
      } catch {
        // Windows ignores POSIX bits; the file is already user-private by ACL.
      }
    } catch (error) {
      // Losing the memory is bad, failing the call over it is worse.
      log?.warn?.(`[dsh-rpc] could not write approval state to ${file}: ${error?.message ?? error}`);
    }
  }

  function ensure(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    let record = state.sessions[sessionId];
    if (!record) {
      record = { used: 0, baseUsed: 0, owned: false, widenedTo: null, updatedAt: 0, rev: 0, reservations: {} };
      state.sessions[sessionId] = record;
    }
    return record;
  }

  function update(sessionId, apply) {
    const record = ensure(sessionId);
    if (!record) return false;
    apply(record);
    record.rev = (record.rev ?? 0) + 1;
    record.updatedAt = now();
    write();
    return true;
  }

  function reserveAllowance(sessionId, reservationId) {
    return update(sessionId, (record) => {
      record.reservations ??= {};
      if (!(reservationId in record.reservations)) record.reservations[reservationId] = "pending";
      record.used = Math.max(record.baseUsed ?? 0, Object.values(record.reservations).filter((status) => status !== "refunded").length);
    });
  }

  function settleAllowance(sessionId, reservationId, status) {
    return update(sessionId, (record) => {
      record.reservations ??= {};
      record.reservations[reservationId] = status;
      record.used = Math.max(record.baseUsed ?? 0, Object.values(record.reservations).filter((value) => value !== "refunded").length);
    });
  }

  function idsWhere(predicate) {
    const found = [];
    for (const [sessionId, record] of Object.entries(state.sessions)) {
      if (predicate(record)) found.push([sessionId, record]);
    }
    found.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    return found;
  }

  return {
    path: file,
    reserveAllowance,
    settleAllowance,

    /** sessionId → escalations already granted. Reservations are written before asking. */
    allowances: {
      get(sessionId) {
        const used = state.sessions[sessionId]?.used ?? 0;
        return used > 0 ? used : undefined;
      },
      has(sessionId) {
        return (state.sessions[sessionId]?.used ?? 0) > 0;
      },
      set(sessionId, used) {
        update(sessionId, (record) => {
          record.baseUsed = Number.isInteger(used) && used > 0 ? used : 0;
          record.used = Math.max(record.baseUsed, Object.values(record.reservations ?? {}).filter((status) => status !== "refunded").length);
        });
        return this;
      },
      delete(sessionId) {
        if (state.sessions[sessionId]) update(sessionId, (record) => { record.baseUsed = 0; record.used = Object.values(record.reservations ?? {}).filter((status) => status !== "refunded").length; });
        return true;
      },
      get size() {
        return idsWhere((record) => record.used > 0).length;
      },
      keys() {
        return idsWhere((record) => record.used > 0).map(([sessionId]) => sessionId)[Symbol.iterator]();
      },
    },

    /** sessionId → the preset to put back once the approved call has run. */
    widened: {
      get(sessionId) {
        return state.sessions[sessionId]?.widenedTo ?? undefined;
      },
      has(sessionId) {
        return Boolean(state.sessions[sessionId]?.widenedTo);
      },
      set(sessionId, previous) {
        update(sessionId, (record) => {
          record.widenedTo = typeof previous === "string" && previous.length > 0 ? previous : null;
        });
        return this;
      },
      delete(sessionId) {
        if (state.sessions[sessionId]?.widenedTo) update(sessionId, (record) => { record.widenedTo = null; });
        return true;
      },
      get size() {
        return idsWhere((record) => record.widenedTo).length;
      },
      keys() {
        return idsWhere((record) => record.widenedTo).map(([sessionId]) => sessionId)[Symbol.iterator]();
      },
      entries() {
        return idsWhere((record) => record.widenedTo).map(([sessionId, record]) => [sessionId, record.widenedTo]);
      },
      [Symbol.iterator]() {
        return this.entries()[Symbol.iterator]();
      },
    },

    /** sessionId → when this bridge created it. */
    owned: {
      get(sessionId) {
        return state.sessions[sessionId]?.owned === true ? state.sessions[sessionId].updatedAt : undefined;
      },
      has(sessionId) {
        return state.sessions[sessionId]?.owned === true;
      },
      set(sessionId, stamp) {
        update(sessionId, (record) => {
          record.owned = true;
          if (Number.isFinite(stamp)) record.updatedAt = stamp;
        });
        return this;
      },
      delete(sessionId) {
        if (state.sessions[sessionId]?.owned === true) update(sessionId, (record) => { record.owned = false; });
        return true;
      },
      get size() {
        return idsWhere((record) => record.owned).length;
      },
      keys() {
        return idsWhere((record) => record.owned).map(([sessionId]) => sessionId)[Symbol.iterator]();
      },
    },

    /** Sessions the journal says may still be wide. Read at startup, then restored. */
    pendingWidens() {
      return idsWhere((record) => record.widenedTo).map(([sessionId, record]) => ({
        sessionId,
        previous: record.widenedTo,
      }));
    },

    /** Drop what the TTL says nobody needs; called once at startup. */
    prune() {
      const stamp = now();
      let changed = false;
      for (const [sessionId, record] of Object.entries(state.sessions)) {
        const idle = stamp - record.updatedAt > STATE_TTL_MS;
        if (record.widenedTo || !idle) continue;
        if (record.owned || record.used > 0) {
          state.sessions[sessionId] = { used: 0, owned: false, widenedTo: null, updatedAt: record.updatedAt };
          changed = true;
        } else {
          delete state.sessions[sessionId];
          changed = true;
        }
      }
      if (changed) write();
    },
  };
}
