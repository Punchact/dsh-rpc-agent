// Persistent bridge state for allowances, ownership and preset-restore obligations.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { stateDir } from "./auth.mjs";

export const APPROVAL_STATE_VERSION = 2 as const;
export const STATE_TTL_MS = 7 * 24 * 60 * 60_000;
export const MAX_STATE_SESSIONS = 2_000;
export const MAX_PENDING_ALLOWANCES = 3;
const LOCK_TIMEOUT_MS = 10_000;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export const RESERVATION_STATES = Object.freeze(["pending", "committed", "refunded"] as const);
export type ReservationState = (typeof RESERVATION_STATES)[number];

export const SETTLE_OUTCOMES = Object.freeze(["committed", "refunded"] as const);
export type SettleOutcome = (typeof SETTLE_OUTCOMES)[number];

/**
 * Exhaustive ticket-reservation transition table for persisted approval allowances.
 */
export const RESERVATION_TRANSITIONS: Readonly<Record<ReservationState, readonly ReservationState[]>> =
  Object.freeze<Record<ReservationState, readonly ReservationState[]>>({
    pending: Object.freeze(["committed", "refunded"]),
    committed: Object.freeze([]),
    refunded: Object.freeze([]),
  });

export interface ApprovalLedgerRecord {
  ledgerVersion: number;
  ledgerEpoch: string;
  sequence: number;
  legacyBase: number;
  legacyCommitted: number;
  legacyPending: Record<string, "pending">;
  committedUsed: number;
  reservations: Record<string, "pending">;
  used: number;
  owned: boolean;
  widenedTo: string | null;
  updatedAt: number;
  rev: number;
}

export interface ApprovalStateFile {
  version: number;
  sessions: Record<string, ApprovalLedgerRecord>;
}

export interface ApprovalStateLogger {
  warn?: (message: string) => void;
}

export interface CreateApprovalStateOptions {
  file?: string;
  log?: ApprovalStateLogger | null;
  now?: () => number;
}

export interface ApprovalStateError extends Error {
  code: "DSH_RPC_APPROVAL_STATE";
}

export interface ApprovalAllowancesMap {
  get(sessionId: string): number | undefined;
  has(sessionId: string): boolean;
  set(sessionId: string, used: number): this;
  delete(sessionId: string): boolean;
  readonly size: number;
  keys(): IterableIterator<string>;
}

export interface ApprovalWidenedMap {
  get(sessionId: string): string | undefined;
  has(sessionId: string): boolean;
  set(sessionId: string, previous: string): this;
  delete(sessionId: string): boolean;
  readonly size: number;
  keys(): IterableIterator<string>;
  entries(): IterableIterator<[string, string | null]>;
  [Symbol.iterator](): IterableIterator<[string, string | null]>;
}

export interface ApprovalOwnedMap {
  get(sessionId: string): number | undefined;
  has(sessionId: string): boolean;
  set(sessionId: string, stamp?: number): this;
  delete(sessionId: string): boolean;
  readonly size: number;
  keys(): IterableIterator<string>;
}

export interface PendingWidenEntry {
  sessionId: string;
  previous: string | null;
}

export interface ApprovalState {
  readonly path: string;
  reserveAllowance: (sessionId: string) => string | null;
  settleAllowance: (sessionId: string, reservationId: string, status: SettleOutcome | string) => boolean;
  allowances: ApprovalAllowancesMap;
  widened: ApprovalWidenedMap;
  owned: ApprovalOwnedMap;
  pendingWidens(): PendingWidenEntry[];
  prune(): void;
}

export function approvalStatePath(env: Record<string, string | undefined> = process.env): string {
  return join(stateDir(env), "approvals.json");
}

function emptyState(): ApprovalStateFile {
  return { version: APPROVAL_STATE_VERSION, sessions: Object.create(null) as Record<string, ApprovalLedgerRecord> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePending(value: unknown): Record<string, "pending"> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, "pending"] => Boolean(entry[0]) && entry[1] === "pending"),
  );
}

function migrateLegacy(record: Record<string, unknown>): {
  legacyBase: number;
  legacyCommitted: number;
  legacyPending: Record<string, "pending">;
} {
  const reservations = isRecord(record.reservations) ? record.reservations : {};
  const legacyPending: Record<string, "pending"> = {};
  let legacyCommitted = 0;
  for (const [id, status] of Object.entries(reservations)) {
    if (!id) continue;
    if (status === "pending") {
      legacyPending[id] = "pending";
    } else if (status === "committed") {
      legacyCommitted += 1;
    }
  }
  const legacyBase =
    typeof record.baseUsed === "number" && Number.isInteger(record.baseUsed) && record.baseUsed >= 0
      ? record.baseUsed
      : Object.keys(reservations).length === 0 && typeof record.used === "number" && Number.isInteger(record.used) && record.used > 0
        ? record.used
        : 0;
  return { legacyBase, legacyCommitted, legacyPending };
}

function usageOf(record: ApprovalLedgerRecord): number {
  const legacyUsed = Math.max(
    record.legacyBase,
    record.legacyCommitted + Object.keys(record.legacyPending).length,
  );
  return legacyUsed + record.committedUsed + Object.keys(record.reservations).length;
}

function sanitize(input: unknown, now: number): ApprovalStateFile {
  const state = emptyState();
  if (!isRecord(input) || !isRecord(input.sessions)) return state;
  const entries: Array<[string, ApprovalLedgerRecord]> = [];
  for (const [sessionId, raw] of Object.entries(input.sessions)) {
    if (!sessionId || !isRecord(raw)) continue;
    const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
    const current = raw.ledgerVersion === 2;
    const legacy = current
      ? {
          legacyBase:
            typeof raw.legacyBase === "number" && Number.isInteger(raw.legacyBase) ? Math.max(0, raw.legacyBase) : 0,
          legacyCommitted:
            typeof raw.legacyCommitted === "number" && Number.isInteger(raw.legacyCommitted)
              ? Math.max(0, raw.legacyCommitted)
              : 0,
          legacyPending: normalizePending(raw.legacyPending),
        }
      : migrateLegacy(raw);
    const record: ApprovalLedgerRecord = {
      ledgerVersion: 2,
      ledgerEpoch: current && typeof raw.ledgerEpoch === "string" ? raw.ledgerEpoch : randomUUID(),
      sequence:
        current && typeof raw.sequence === "number" && Number.isSafeInteger(raw.sequence)
          ? Math.max(0, raw.sequence)
          : 0,
      legacyBase: legacy.legacyBase,
      legacyCommitted: legacy.legacyCommitted,
      legacyPending: legacy.legacyPending,
      committedUsed:
        current && typeof raw.committedUsed === "number" && Number.isInteger(raw.committedUsed)
          ? Math.max(0, raw.committedUsed)
          : 0,
      reservations: current ? normalizePending(raw.reservations) : {},
      used: 0,
      owned: raw.owned === true,
      widenedTo: typeof raw.widenedTo === "string" && raw.widenedTo.length > 0 ? raw.widenedTo : null,
      updatedAt,
      rev: typeof raw.rev === "number" && Number.isInteger(raw.rev) ? raw.rev : 0,
    };
    record.used = usageOf(record);
    const hasPending = Object.keys(record.legacyPending).length > 0 || Object.keys(record.reservations).length > 0;
    if (!record.widenedTo && !hasPending && now - updatedAt > STATE_TTL_MS) continue;
    entries.push([sessionId, record]);
  }
  const obligations = entries.filter(([, record]) =>
    Boolean(record.widenedTo) || Object.keys(record.legacyPending).length > 0 || Object.keys(record.reservations).length > 0,
  );
  const obligationIds = new Set(obligations.map(([sessionId]) => sessionId));
  const ordinary = entries
    .filter(([sessionId]) => !obligationIds.has(sessionId))
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt);
  for (const [sessionId, record] of [
    ...obligations,
    ...ordinary.slice(0, Math.max(0, MAX_STATE_SESSIONS - obligations.length)),
  ]) {
    state.sessions[sessionId] = record;
  }
  return state;
}

function lockPath(file: string): string {
  return `${file}.lock`;
}

function errCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && error.message !== undefined && error.message !== null) {
    return String(error.message);
  }
  return String(error);
}

function acquireFileLock(file: string): () => void {
  const path = lockPath(file);
  const token = randomUUID();
  const stage = `${path}.${token}.stage`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  mkdirSync(stage, { mode: 0o700 });
  try {
    writeFileSync(join(stage, "owner.json"), JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
    while (Date.now() < deadline) {
      try {
        // The fully initialized directory becomes the lock in one same-volume
        // rename; contenders never see a half-written owner record.
        renameSync(stage, path);
        return () => {
          let owner: { token?: unknown };
          try {
            owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { token?: unknown };
          } catch {
            return;
          }
          if (owner.token !== token) return;
          const released = `${path}.${token}.released`;
          try {
            renameSync(path, released);
            rmSync(released, { recursive: true, force: true });
          } catch (error: unknown) {
            if (errCode(error) !== "ENOENT") throw error;
          }
        };
      } catch (error: unknown) {
        const code = errCode(error);
        if (!code || !["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(code) || !existsSync(path)) throw error;
        Atomics.wait(WAIT_BUFFER, 0, 0, 10);
      }
    }
    throw new Error(`timed out acquiring approval state lock ${path}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function stateError(message: string, cause?: unknown): ApprovalStateError {
  const error = new Error(message, cause !== undefined ? { cause } : undefined) as ApprovalStateError;
  error.code = "DSH_RPC_APPROVAL_STATE";
  return error;
}

function loadFrom(file: string, logger: ApprovalStateLogger | null, stamp: number): ApprovalStateFile {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(file, "utf8"));
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") return emptyState();
    logger?.warn?.(`[dsh-rpc] approval state at ${file} is unreadable; preserving the original file`);
    throw stateError(`approval state at ${file} is unreadable`, error);
  }
  if (!isRecord(input) || ![1, 2].includes(input.version as number) || !isRecord(input.sessions)) {
    throw stateError(`approval state at ${file} has an unsupported format`);
  }
  for (const record of Object.values(input.sessions)) {
    if (!isRecord(record) || (input.version === 2 && record.ledgerVersion !== 2)) {
      throw stateError(`approval state at ${file} contains an invalid session record`);
    }
    if (
      record.ledgerVersion === 2 &&
      (typeof record.ledgerEpoch !== "string" ||
        record.ledgerEpoch.length === 0 ||
        typeof record.sequence !== "number" ||
        !Number.isSafeInteger(record.sequence) ||
        record.sequence < 0 ||
        typeof record.committedUsed !== "number" ||
        !Number.isSafeInteger(record.committedUsed) ||
        record.committedUsed < 0 ||
        typeof record.legacyBase !== "number" ||
        !Number.isSafeInteger(record.legacyBase) ||
        record.legacyBase < 0 ||
        typeof record.legacyCommitted !== "number" ||
        !Number.isSafeInteger(record.legacyCommitted) ||
        record.legacyCommitted < 0 ||
        !isRecord(record.reservations) ||
        !isRecord(record.legacyPending))
    ) {
      throw stateError(`approval state at ${file} contains an invalid ticket ledger`);
    }
  }
  return sanitize(input, stamp);
}

export function createApprovalState({
  file = approvalStatePath(),
  log = null,
  now = () => Date.now(),
}: CreateApprovalStateOptions = {}): ApprovalState {
  let state = loadFrom(file, log, now());

  function persist(next: ApprovalStateFile): void {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2), { flag: "wx", mode: 0o600 });
      renameSync(temporary, file);
      try {
        chmodSync(file, 0o600);
      } catch {
        // Windows enforces the user profile ACL instead of POSIX mode bits.
      }
    } catch (error: unknown) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Keep the original write error.
      }
      log?.warn?.(`[dsh-rpc] could not write approval state to ${file}: ${errMessage(error)}`);
      throw error;
    }
  }

  function transaction<T>(
    sessionId: string,
    mutate: (record: ApprovalLedgerRecord) => { changed?: boolean; value: T },
  ): { ok: true; value: T } | { ok: false; value: false } {
    if (typeof sessionId !== "string" || sessionId.length === 0) return { ok: false, value: false };
    let release: (() => void) | undefined;
    try {
      release = acquireFileLock(file);
      const fresh = loadFrom(file, null, now());
      let record: ApprovalLedgerRecord | null = Object.hasOwn(fresh.sessions, sessionId) ? fresh.sessions[sessionId] : null;
      if (!record) {
        record = {
          ledgerVersion: 2,
          ledgerEpoch: randomUUID(),
          sequence: 0,
          legacyBase: 0,
          legacyCommitted: 0,
          legacyPending: {},
          committedUsed: 0,
          reservations: {},
          used: 0,
          owned: false,
          widenedTo: null,
          updatedAt: 0,
          rev: 0,
        };
        fresh.sessions[sessionId] = record;
      }
      const result = mutate(record);
      if (result?.changed === false) {
        state = fresh;
        return { ok: true, value: result.value };
      }
      record.rev += 1;
      record.updatedAt = now();
      record.used = usageOf(record);
      persist(fresh);
      state = fresh;
      return { ok: true, value: result.value };
    } catch (error: unknown) {
      if (errCode(error) === "DSH_RPC_APPROVAL_STATE") throw error;
      throw stateError(`approval state transaction failed for ${file}`, error);
    } finally {
      release?.();
    }
  }

  function update(sessionId: string, applyFn: (record: ApprovalLedgerRecord) => void): boolean {
    const result = transaction(sessionId, (record) => {
      applyFn(record);
      return { value: true };
    });
    return result.ok && result.value;
  }

  function reserveAllowance(sessionId: string): string | null {
    try {
      const result = transaction<string | null>(sessionId, (record) => {
        if (record.used >= MAX_PENDING_ALLOWANCES || record.sequence >= Number.MAX_SAFE_INTEGER) {
          return { changed: false, value: null };
        }
        record.sequence += 1;
        const reservationId = `${record.ledgerEpoch}:${record.sequence}`;
        record.reservations[reservationId] = "pending";
        return { value: reservationId };
      });
      return result.ok ? result.value : null;
    } catch (error: unknown) {
      log?.warn?.(`[dsh-rpc] could not reserve an approval allowance for ${sessionId}: ${errMessage(error)}`);
      return null;
    }
  }

  function settleAllowance(sessionId: string, reservationId: string, status: SettleOutcome | string): boolean {
    if (typeof reservationId !== "string" || !(SETTLE_OUTCOMES as readonly string[]).includes(status)) return false;
    const outcome = status as SettleOutcome;
    const result = transaction<boolean>(sessionId, (record) => {
      if (Object.hasOwn(record.reservations, reservationId)) {
        delete record.reservations[reservationId];
        if (outcome === "committed") record.committedUsed += 1;
        return { value: true };
      }
      if (Object.hasOwn(record.legacyPending, reservationId)) {
        delete record.legacyPending[reservationId];
        if (outcome === "committed") record.legacyCommitted += 1;
        if (Object.keys(record.legacyPending).length === 0) {
          record.legacyBase = Math.max(record.legacyBase, record.legacyCommitted);
          record.legacyCommitted = 0;
        }
        return { value: true };
      }
      return { changed: false, value: false };
    });
    return result.ok && result.value;
  }

  function idsWhere(predicate: (record: ApprovalLedgerRecord) => unknown): Array<[string, ApprovalLedgerRecord]> {
    const found: Array<[string, ApprovalLedgerRecord]> = [];
    for (const [sessionId, record] of Object.entries(state.sessions)) {
      if (predicate(record)) found.push([sessionId, record]);
    }
    found.sort((left, right) => left[1].updatedAt - right[1].updatedAt);
    return found;
  }

  const allowances: ApprovalAllowancesMap = {
    get(sessionId) {
      const used = state.sessions[sessionId]?.used ?? 0;
      return used > 0 ? used : undefined;
    },
    has(sessionId) {
      return (state.sessions[sessionId]?.used ?? 0) > 0;
    },
    set(sessionId, used) {
      update(sessionId, (record) => {
        record.legacyBase = Number.isInteger(used) && used > 0 ? used : 0;
      });
      return this;
    },
    delete(sessionId) {
      if (state.sessions[sessionId]) {
        update(sessionId, (record) => {
          record.legacyBase = 0;
        });
      }
      return true;
    },
    get size() {
      return idsWhere((record) => record.used > 0).length;
    },
    keys() {
      return idsWhere((record) => record.used > 0)
        .map(([sessionId]) => sessionId)
        [Symbol.iterator]();
    },
  };

  const widened: ApprovalWidenedMap = {
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
      if (state.sessions[sessionId]?.widenedTo) {
        update(sessionId, (record) => {
          record.widenedTo = null;
        });
      }
      return true;
    },
    get size() {
      return idsWhere((record) => record.widenedTo).length;
    },
    keys() {
      return idsWhere((record) => record.widenedTo)
        .map(([sessionId]) => sessionId)
        [Symbol.iterator]();
    },
    entries() {
      return idsWhere((record) => record.widenedTo)
        .map(([sessionId, record]): [string, string | null] => [sessionId, record.widenedTo])
        [Symbol.iterator]();
    },
    [Symbol.iterator]() {
      return this.entries();
    },
  };

  const owned: ApprovalOwnedMap = {
    get(sessionId) {
      return state.sessions[sessionId]?.owned === true ? state.sessions[sessionId].updatedAt : undefined;
    },
    has(sessionId) {
      return state.sessions[sessionId]?.owned === true;
    },
    set(sessionId, stamp) {
      update(sessionId, (record) => {
        record.owned = true;
        if (typeof stamp === "number" && Number.isFinite(stamp)) record.updatedAt = stamp;
      });
      return this;
    },
    delete(sessionId) {
      if (state.sessions[sessionId]?.owned === true) {
        update(sessionId, (record) => {
          record.owned = false;
        });
      }
      return true;
    },
    get size() {
      return idsWhere((record) => record.owned).length;
    },
    keys() {
      return idsWhere((record) => record.owned)
        .map(([sessionId]) => sessionId)
        [Symbol.iterator]();
    },
  };

  return {
    path: file,
    reserveAllowance,
    settleAllowance,
    allowances,
    widened,
    owned,
    pendingWidens() {
      return idsWhere((record) => record.widenedTo).map(([sessionId, record]) => ({
        sessionId,
        previous: record.widenedTo,
      }));
    },
    prune() {
      const release = acquireFileLock(file);
      try {
        const fresh = loadFrom(file, null, now());
        let changed = false;
        for (const [sessionId, record] of Object.entries(fresh.sessions)) {
          const idle = now() - record.updatedAt > STATE_TTL_MS;
          const hasPending = Object.keys(record.legacyPending).length > 0 || Object.keys(record.reservations).length > 0;
          if (record.widenedTo || hasPending || !idle) continue;
          if (record.owned || record.used > 0) {
            fresh.sessions[sessionId] = {
              ...record,
              used: 0,
              legacyBase: 0,
              legacyCommitted: 0,
              legacyPending: {},
              committedUsed: 0,
              reservations: {},
              owned: false,
            };
          } else {
            delete fresh.sessions[sessionId];
          }
          changed = true;
        }
        if (changed) persist(fresh);
        state = fresh;
      } finally {
        release();
      }
    },
  };
}
