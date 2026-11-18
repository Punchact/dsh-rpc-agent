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
