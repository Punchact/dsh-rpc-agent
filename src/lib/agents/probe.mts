// Adapter-agnostic, read-only probe orchestrator for agent capability controls.
// Each control probe runs with its own independent timeout; a timeout, rejection,
// or non-`true` return becomes `unknown` and never aborts sibling probes.

import type { AdapterProbeResult } from "../adapters/base.mjs";
import { CONTROL_NAMES, type ControlName } from "./card.mjs";

const DEFAULT_TIMEOUT_MS = 5_000;

export type ProbeFn = () => Promise<boolean> | boolean | unknown;

export type ProbeMap = Partial<Record<ControlName, ProbeFn>>;

export interface ProberOptions {
  probes?: ProbeMap | Record<string, ProbeFn>;
  timeoutMs?: number;
  now?: () => number;
}

export interface ProbeUnknownEntry {
  control: ControlName | string;
  reason: string;
}

export interface ProbeAllResult {
  verified: Partial<Record<ControlName, true>>;
  unknown: ProbeUnknownEntry[];
  elapsedMs: number;
}

export interface Prober {
  probeAll(controlNames?: readonly ControlName[]): Promise<ProbeAllResult>;
}

export interface ProbeableAdapter {
  probe?: () => Promise<
    AdapterProbeResult | { ok?: boolean; controls?: Partial<Record<ControlName, boolean>> }
  >;
}

type TimeoutOutcome = { ok: true } | { ok: false; reason: string };

function runWithTimeout(fn: ProbeFn, timeoutMs: number): Promise<TimeoutOutcome> {
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
        (err: unknown) => {
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
 */
export function createProber({
  probes = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
}: ProberOptions = {}): Prober {
  const perProbeTimeout = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  return {
    async probeAll(controlNames: readonly ControlName[] = CONTROL_NAMES): Promise<ProbeAllResult> {
      const startedAt = now();
      const targets: readonly ControlName[] = Array.isArray(controlNames) ? controlNames : CONTROL_NAMES;

      const results = await Promise.all(
        targets.map(async (control) => {
          const fn = (probes as Record<string, ProbeFn | undefined>)?.[control];
          if (typeof fn !== "function") {
            return { control, ok: false as const, reason: "rejected" };
          }
          const outcome = await runWithTimeout(fn, perProbeTimeout);
          return { control, ...outcome };
        }),
      );

      const verified: Partial<Record<ControlName, true>> = {};
      const unknown: ProbeUnknownEntry[] = [];
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
 */
export function probesFromAdapter(
  adapter?: ProbeableAdapter | null,
): Record<ControlName, () => Promise<boolean>> {
  let pending: Promise<AdapterProbeResult | { ok?: boolean; controls?: Partial<Record<ControlName, boolean>> } | null> | null =
    null;
  const controlsOf = () => {
    if (!adapter || typeof adapter.probe !== "function") return Promise.resolve(null);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => adapter.probe!())
        .catch(() => null);
    }
    return pending;
  };

  const probes = {} as Record<ControlName, () => Promise<boolean>>;
  for (const control of CONTROL_NAMES) {
    probes[control] = async () => {
      const result = await controlsOf();
      return result?.ok === true && result?.controls?.[control] === true;
    };
  }
  return probes;
}
