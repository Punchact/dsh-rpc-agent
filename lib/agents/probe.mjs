// Adapter-agnostic, read-only probe orchestrator for agent capability controls.
// Each control probe runs with its own independent timeout; a timeout, rejection,
// or non-`true` return becomes `unknown` and never aborts sibling probes.

import { CONTROL_NAMES } from "./card.mjs";

const DEFAULT_TIMEOUT_MS = 5_000;

function runWithTimeout(fn, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    Promise.resolve()
      .then(() => fn())
      .then(
        (val) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (val === true) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, reason: "rejected" });
          }
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const msg = err instanceof Error ? err.message : String(err);
          resolve({ ok: false, reason: `threw:${msg}` });
        },
      );
  });
}

/**
 * Create a probe runner over caller-supplied read-only probe functions.
 *
 * @param {object} [options]
 * @param {Record<string, () => Promise<boolean>|boolean>} [options.probes={}]
 * @param {number} [options.timeoutMs=5000]
 * @param {() => number} [options.now=Date.now]
 */
export function createProber({ probes = {}, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
  const perProbeTimeout = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  return {
    async probeAll(controlNames = CONTROL_NAMES) {
      const startedAt = now();
      const targets = Array.isArray(controlNames) ? controlNames : CONTROL_NAMES;

      const results = await Promise.all(
        targets.map(async (control) => {
          const fn = probes?.[control];
          if (typeof fn !== "function") {
            return { control, ok: false, reason: "rejected" };
          }
          const outcome = await runWithTimeout(fn, perProbeTimeout);
          return { control, ...outcome };
        }),
      );

      const verified = {};
      const unknown = [];
      for (const item of results) {
        if (item.ok) {
          verified[item.control] = true;
        } else {
          unknown.push({ control: item.control, reason: item.reason });
        }
      }

      return {
        verified,
        unknown,
        elapsedMs: Math.max(0, now() - startedAt),
      };
    },
  };
}

/**
 * Turn one adapter's `probe()` answer into the per-control probe map this module wants.
 *
 * Adapters answer the whole control table in one read-only call
 * (`{ ok, controls: { start, steer, ... } }`), while `createProber` wants one function
 * per control. Without this bridge the orkestrator sees `undefined` for every control
 * and reports `rejected` for all six — a registered agent could never become verified,
 * no matter how healthy its executor was.
 *
 * The adapter call is memoised per map instance, so a probe round costs one round-trip
 * instead of six, and a failed call fails every control for that round instead of
 * hammering a dead language server.
 *
 * @param {{ probe?: () => Promise<{ok?: boolean, controls?: Record<string, boolean>}> }} [adapter]
 * @returns {Record<string, () => Promise<boolean>>}
 */
export function probesFromAdapter(adapter) {
  let pending = null;
  const controlsOf = () => {
    if (!adapter || typeof adapter.probe !== "function") return Promise.resolve(null);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => adapter.probe())
        .catch(() => null);
    }
    return pending;
  };

  const probes = {};
  for (const control of CONTROL_NAMES) {
    probes[control] = async () => {
      const result = await controlsOf();
      return result?.ok === true && result?.controls?.[control] === true;
    };
  }
  return probes;
}
