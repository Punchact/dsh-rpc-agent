// Call accounting for the status page.
//
// Deliberately narrow: method name, wall time, outcome code — never the params.
// The prompt text, session ids and tool arguments stay out of this structure so
// that `/status` (loopback, unauthenticated by design) cannot become a side
// channel for what a caller asked DSH to do.

const MAX_RECENT = 12;

export function createStats({ startedAt = Date.now(), pid = process.pid, ring = MAX_RECENT } = {}) {
  const byMethod = new Map();
  const recent = [];
  let total = 0;
  let errors = 0;
  let lastCallAt = null;
  let lastErrorAt = null;
  // Outcomes that are not failures but still matter: a turn we stopped waiting for
  // looks like a success in `total`, and a client that hung up looks like neither.
  const outcomes = { timeouts: 0, cancelledByClient: 0 };
  // Approvals this bridge answered itself. Kept apart from `outcomes` because no
  // call produced them: the count tells an operator whether their unattended
  // sessions are actually hitting the sandbox wall.
  const approvals = { denied: 0 };

  return {
    startedAt,
    pid,

    /** Called once per approval this bridge answered instead of a human. */
    recordApproval(outcome = "denied") {
      if (outcome === "denied") approvals.denied += 1;
    },

    /** Called once per admitted call. `code` is the JSON-RPC code when it failed. */
    record(method, ms, ok, code = null, outcome = null) {
      const name = typeof method === "string" && method.length > 0 ? method : "?";
      const at = new Date().toISOString();

      total += 1;
      if (!ok) errors += 1;
      if (outcome && Object.hasOwn(outcomes, outcome)) outcomes[outcome] += 1;

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

    snapshot() {
      const methods = {};
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
