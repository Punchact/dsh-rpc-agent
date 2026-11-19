// Call accounting for the status page.
//
// Deliberately narrow: method name, wall time, outcome code — never the params.
// The prompt text, session ids and tool arguments stay out of this structure so
// that `/status` (loopback, unauthenticated by design) cannot become a side
// channel for what a caller asked DSH to do.

const MAX_RECENT = 12;

export interface StatsMethodEntry {
  count: number;
  errors: number;
  lastMs: number | null;
  lastAt: string | null;
}

export interface StatsRecentEntry {
  method: string;
  ms: number;
  ok: boolean;
  code: number | null;
  at: string;
}

export interface StatsSnapshot {
  total: number;
  errors: number;
  lastCallAt: string | null;
  lastErrorAt: string | null;
  outcomes: {
    timeouts: number;
    cancelledByClient: number;
  };
  approvals: {
    denied: number;
    allowed: number;
  };
  byMethod: Record<string, StatsMethodEntry>;
  recent: StatsRecentEntry[];
}

export interface CreateStatsOptions {
  startedAt?: number;
  pid?: number;
  ring?: number;
}

export interface StatsTracker {
  readonly startedAt: number;
  readonly pid: number;
  recordApproval(outcome?: "denied" | "allowed" | string): void;
  record(
    method: string,
    ms: number,
    ok: boolean,
    code?: number | null,
    outcome?: string | null,
  ): void;
  snapshot(): StatsSnapshot;
}

export function createStats({
  startedAt = Date.now(),
  pid = process.pid,
  ring = MAX_RECENT,
}: CreateStatsOptions = {}): StatsTracker {
  const byMethod = new Map<string, StatsMethodEntry>();
  const recent: StatsRecentEntry[] = [];
  let total = 0;
  let errors = 0;
  let lastCallAt: string | null = null;
  let lastErrorAt: string | null = null;
  // Outcomes that are not failures but still matter: a turn we stopped waiting for
  // looks like a success in `total`, and a client that hung up looks like neither.
  const outcomes: { timeouts: number; cancelledByClient: number } = { timeouts: 0, cancelledByClient: 0 };
  // Approvals this bridge answered itself. Kept apart from `outcomes` because no
  // call produced them: the count tells an operator whether their unattended
  // sessions are actually hitting the sandbox wall. `allowed` only ever moves
  // under approvals.mode=delegate — this bridge never grants on its own.
  const approvals = { denied: 0, allowed: 0 };

  return {
    startedAt,
    pid,

    /** Called once per approval this bridge answered instead of a human. */
    recordApproval(outcome: "denied" | "allowed" | string = "denied"): void {
      if (outcome === "denied") approvals.denied += 1;
      else if (outcome === "allowed") approvals.allowed += 1;
    },

    /** Called once per admitted call. `code` is the JSON-RPC code when it failed. */
    record(
      method: string,
      ms: number,
      ok: boolean,
      code: number | null = null,
      outcome: string | null = null,
    ): void {
      const name = typeof method === "string" && method.length > 0 ? method : "?";
      const at = new Date().toISOString();

      total += 1;
      if (!ok) errors += 1;
      if (outcome && Object.hasOwn(outcomes, outcome)) {
        outcomes[outcome as keyof typeof outcomes] += 1;
      }

      const entry = byMethod.get(name) ?? { count: 0, errors: 0, lastMs: null, lastAt: null };
      entry.count += 1;
      if (!ok) entry.errors += 1;
      entry.lastMs = ms;
      entry.lastAt = at;
      byMethod.set(name, entry);

      recent.unshift({ method: name, ms, ok, code, at });
      if (recent.length > ring) recent.length = ring;

      lastCallAt = at;
      if (!ok) lastErrorAt = at;
    },

    snapshot(): StatsSnapshot {
      const methods: Record<string, StatsMethodEntry> = {};
      for (const [name, entry] of [...byMethod.entries()].sort((a, b) => b[1].count - a[1].count)) {
        methods[name] = { ...entry };
      }
      return {
        total,
        errors,
        lastCallAt,
        lastErrorAt,
        outcomes: { ...outcomes },
        approvals: { ...approvals },
        byMethod: methods,
        recent: recent.map((item) => ({ ...item })),
      };
    },
  };
}
