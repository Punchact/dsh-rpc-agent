// Agent capability card (L1, §4.2): declared != verified.
// Cards are normalized and hashed deterministically; `verified: true` can only
// be produced via `withVerified(...)` after a real probe run.

import { createHash } from "node:crypto";

import { TASK_ERROR, taskError, type TaskError } from "../tasks/errors.mjs";

export const CARD_VERSION = "capability-card@1" as const;

export const CONTROL_NAMES = Object.freeze([
  "start",
  "steer",
  "cancel",
  "inspect",
  "approval",
  "events",
] as const);

export type ControlName = (typeof CONTROL_NAMES)[number];

export const CONTROL_SUPPORTS = Object.freeze(["required", "optional", "unsupported"] as const);

export type ControlSupport = (typeof CONTROL_SUPPORTS)[number];

export type ControlVerifyState = "verified" | "unsupported" | "unknown";

export interface ControlDeclaration {
  support: ControlSupport;
  evidence: string;
}

export interface VerifiedControlEntry extends ControlDeclaration {
  verified: boolean;
}

export interface CardIdentity {
  agentId: string;
  name: string;
  kind: string;
  version: string;
}

export interface CardLimits {
  maxConcurrent?: number;
  maxRuntimeMs?: number;
  maxInputChars?: number;
}

export interface CapabilityDeclaration {
  capabilityId: string;
  version: number;
  sideEffectKind: "read" | "write";
  cancelPolicy: "required" | "optional";
  schema: Record<string, unknown>;
  limitations?: string[];
}

export interface NormalizedCard {
  cardVersion: typeof CARD_VERSION;
  identity: CardIdentity;
  controls: Record<ControlName, ControlDeclaration>;
  limits: CardLimits;
  limitations: string[];
  capabilities: CapabilityDeclaration[];
  declared: true;
  verified: false;
  evidence?: string[];
}

export interface VerifiedCard extends Omit<NormalizedCard, "controls" | "verified"> {
  controls: Record<ControlName, VerifiedControlEntry>;
  declared: true;
  verified: boolean;
  partial: boolean;
  verifiedControls: ControlName[];
  evidence: string[];
  unknown: ControlName[];
}

export type VerifiedControlInput =
  | Partial<Record<ControlName, boolean | { verified?: boolean }>>
  | { verified?: Partial<Record<ControlName, boolean | { verified?: boolean }>> };

const CONTROL_NAME_SET: ReadonlySet<string> = new Set(CONTROL_NAMES);
const CONTROL_SUPPORT_SET: ReadonlySet<string> = new Set(CONTROL_SUPPORTS);
const LIMIT_KEYS: ReadonlySet<string> = new Set(["maxConcurrent", "maxRuntimeMs", "maxInputChars"]);

export function isControlName(name: unknown): name is ControlName {
  return typeof name === "string" && CONTROL_NAME_SET.has(name);
}

export function controlVerifyState(entry: Pick<VerifiedControlEntry, "support" | "verified">): ControlVerifyState {
  if (entry.support === "unsupported") return "unsupported";
  if (entry.verified === true) return "verified";
  return "unknown";
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

function invalidCard(message: string, data: Record<string, unknown> = {}): TaskError {
  return taskError(TASK_ERROR.INVALID_CARD, message, data);
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidCard(`card.${path} must be a non-empty string`, { path });
  }
  return value.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate and normalize an agent capability card.
 * Enforces declared != verified: `normalizeCard` always yields `declared: true, verified: false`.
 */
export function normalizeCard(input: unknown): NormalizedCard {
  if (!isPlainObject(input)) {
    throw invalidCard("card must be a JSON object");
  }

  if (input.cardVersion !== undefined && input.cardVersion !== CARD_VERSION) {
    throw invalidCard(`unsupported cardVersion "${String(input.cardVersion)}"; expected "${CARD_VERSION}"`, {
      path: "cardVersion",
    });
  }

  if (!isPlainObject(input.identity)) {
    throw invalidCard("card.identity is required and must be an object", { path: "identity" });
  }
  const identity: CardIdentity = {
    agentId: requireNonEmptyString(input.identity.agentId, "identity.agentId"),
    name: requireNonEmptyString(input.identity.name, "identity.name"),
    kind: requireNonEmptyString(input.identity.kind, "identity.kind"),
    version: requireNonEmptyString(input.identity.version, "identity.version"),
  };

  if (!isPlainObject(input.controls)) {
    throw invalidCard("card.controls is required and must be an object", { path: "controls" });
  }
  for (const key of Object.keys(input.controls)) {
    if (!CONTROL_NAME_SET.has(key)) {
      throw invalidCard(`unknown control name "${key}" in card.controls`, { path: `controls.${key}` });
    }
  }
  const controls = {} as Record<ControlName, ControlDeclaration>;
  for (const name of CONTROL_NAMES) {
    const entry = input.controls[name];
    if (!isPlainObject(entry)) {
      throw invalidCard(`card.controls.${name} is required and must be an object`, {
        path: `controls.${name}`,
      });
    }
    if (typeof entry.support !== "string" || !CONTROL_SUPPORT_SET.has(entry.support)) {
      throw invalidCard(
        `card.controls.${name}.support must be one of ${CONTROL_SUPPORTS.join("|")}; got ${String(entry.support)}`,
        { path: `controls.${name}.support` },
      );
    }
    if (typeof entry.evidence !== "string") {
      throw invalidCard(`card.controls.${name}.evidence must be a string`, {
        path: `controls.${name}.evidence`,
      });
    }
    controls[name] = {
      support: entry.support as ControlSupport,
      evidence: entry.evidence.trim(),
    };
  }

  const limits: CardLimits = {};
  if (input.limits !== undefined) {
    if (!isPlainObject(input.limits)) {
      throw invalidCard("card.limits must be an object when provided", { path: "limits" });
    }
    for (const [key, val] of Object.entries(input.limits)) {
      if (!LIMIT_KEYS.has(key)) {
        throw invalidCard(`unknown limit key "${key}" in card.limits`, { path: `limits.${key}` });
      }
      if (val !== undefined) {
        if (typeof val !== "number" || !Number.isInteger(val) || val <= 0) {
          throw invalidCard(`card.limits.${key} must be a positive integer`, { path: `limits.${key}` });
        }
        limits[key as keyof CardLimits] = val;
      }
    }
  }

  if (!("limitations" in input) || !Array.isArray(input.limitations)) {
    throw invalidCard("card.limitations is required and must be an array of strings", {
      path: "limitations",
    });
  }
  const limitations = input.limitations.map((item, idx) => {
    if (typeof item !== "string") {
      throw invalidCard(`card.limitations[${idx}] must be a string`, {
        path: `limitations[${idx}]`,
      });
    }
    return item.trim();
  });
  // §4.2 rule 1 (acceptance A17): a card that only advertises capability and admits no
  // weakness is an advertisement, not a capability declaration — reject it at registration.
  if (limitations.length === 0 || limitations.every((item) => item.length === 0)) {
    throw invalidCard(
      "card.limitations must name at least one known weakness (an empty list means the card was not reviewed)",
      { path: "limitations" },
    );
  }

  // Declared capabilities (optional). A capability without an immutable revision
  // cannot be previewed or submitted, so registration publishes one per entry.
  const capabilities: CapabilityDeclaration[] = [];
  const rawCapabilities = input.capabilities === undefined ? [] : input.capabilities;
  if (!Array.isArray(rawCapabilities)) {
    throw invalidCard("card.capabilities must be an array when provided", { path: "capabilities" });
  }
  for (let idx = 0; idx < rawCapabilities.length; idx += 1) {
    const entry = rawCapabilities[idx];
    if (!isPlainObject(entry)) {
      throw invalidCard(`card.capabilities[${idx}] must be an object`, { path: `capabilities[${idx}]` });
    }
    const capabilityId = requireNonEmptyString(entry.capabilityId, `capabilities[${idx}].capabilityId`);
    const version = entry.version === undefined ? 1 : entry.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) {
      throw invalidCard(`card.capabilities[${idx}].version must be a positive integer`, {
        path: `capabilities[${idx}].version`,
      });
    }
    const sideEffectKind = entry.sideEffectKind === undefined ? "read" : entry.sideEffectKind;
    if (sideEffectKind !== "read" && sideEffectKind !== "write") {
      throw invalidCard(`card.capabilities[${idx}].sideEffectKind must be "read" or "write"`, {
        path: `capabilities[${idx}].sideEffectKind`,
      });
    }
    if (entry.schema !== undefined && !isPlainObject(entry.schema)) {
      throw invalidCard(`card.capabilities[${idx}].schema must be an object`, {
        path: `capabilities[${idx}].schema`,
      });
    }
    let capabilityLimitations: string[] | null = null;
    if (entry.limitations !== undefined && entry.limitations !== null) {
      if (!Array.isArray(entry.limitations)) {
        throw invalidCard(`card.capabilities[${idx}].limitations must be an array of strings`, {
          path: `capabilities[${idx}].limitations`,
        });
      }
      capabilityLimitations = entry.limitations.map((item, itemIdx) => {
        if (typeof item !== "string") {
          throw invalidCard(
            `card.capabilities[${idx}].limitations[${itemIdx}] must be a string`,
            { path: `capabilities[${idx}].limitations[${itemIdx}]` },
          );
        }
        return item.trim();
      });
    }
    // §4.2 rule 4: a write capability must require cancellation; only read/short
    // work may allow a degraded peer without it. An explicit contradiction is
    // rejected rather than silently coerced, so the author sees the mistake.
    const declaredCancelPolicy = entry.cancelPolicy;
    if (
      declaredCancelPolicy !== undefined &&
      declaredCancelPolicy !== "required" &&
      declaredCancelPolicy !== "optional"
    ) {
      throw invalidCard(`card.capabilities[${idx}].cancelPolicy must be "required" or "optional"`, {
        path: `capabilities[${idx}].cancelPolicy`,
      });
    }
    if (sideEffectKind === "write" && declaredCancelPolicy === "optional") {
      throw invalidCard(
        `card.capabilities[${idx}] writes side effects, so cancelPolicy must be "required"`,
        { path: `capabilities[${idx}].cancelPolicy` },
      );
    }
    const cancelPolicy = declaredCancelPolicy ?? (sideEffectKind === "write" ? "required" : "optional");
    capabilities.push({
      capabilityId,
      version,
      sideEffectKind,
      cancelPolicy,
      schema: (entry.schema as Record<string, unknown> | undefined) ?? {},
      // Omit the key when nothing was declared: a normalised card must survive a
      // second normalisation pass (withVerified re-normalises).
      ...(capabilityLimitations ? { limitations: capabilityLimitations } : {}),
    });
  }

  return {
    cardVersion: CARD_VERSION,
    identity,
    controls,
    limits,
    limitations,
    capabilities,
    declared: true,
    verified: false,
  };
}

/**
 * Deterministic revision id for one declared capability of one card revision.
 * The same card + capability always yields the same id, so re-registering an
 * unchanged card cannot churn history; any card change yields a new revision.
 */
export function capabilityRevisionId(cardHash: string, capabilityId: string, version: number | string): string {
  const digest = createHash("sha256")
    .update(`${cardHash}|capability|${capabilityId}|${version}`)
    .digest("hex");
  return `cap_${digest.slice(0, 24)}`;
}

/**
 * Compute a deterministic sha256 digest of a card regardless of object key ordering.
 */
export function hashCard(card: unknown): string {
  return createHash("sha256").update(stableStringify(card)).digest("hex");
}

/**
 * Return a verified copy of `card` after a probe run without mutating the
 * declared `controls[*].support` postures. Unsettled controls land in `unknown[]`.
 */
export function withVerified(
  card: unknown,
  verifiedControls: VerifiedControlInput = {},
  evidence: unknown[] = [],
): VerifiedCard {
  const candidate = card as Partial<NormalizedCard> | null | undefined;
  const base: NormalizedCard =
    candidate?.cardVersion === CARD_VERSION && candidate?.declared === true
      ? (candidate as NormalizedCard)
      : normalizeCard(card);
  const vcObj = verifiedControls as { verified?: unknown } & Record<string, unknown>;
  const settledMap = isPlainObject(vcObj?.verified) ? vcObj.verified : vcObj;
  const isSettled = (name: ControlName): boolean => {
    const val = settledMap?.[name];
    return val === true || (isPlainObject(val) && val.verified === true);
  };

  const controls = {} as Record<ControlName, VerifiedControlEntry>;
  const unknown: ControlName[] = [];
  const settled: ControlName[] = [];

  for (const name of CONTROL_NAMES) {
    const prev = base.controls[name];
    // A control the agent declares as unsupported cannot be probed; it is excluded
    // from the settlement test rather than counted as a probe failure.
    const ok = prev.support === "unsupported" ? false : isSettled(name);
    controls[name] = { support: prev.support, evidence: prev.evidence, verified: ok };
    if (ok) settled.push(name);
    else if (prev.support !== "unsupported") unknown.push(name);
  }

  const settleable = CONTROL_NAMES.filter((name) => base.controls[name].support !== "unsupported");
  // "verified" is only true when every probe-able control actually answered; a card
  // that settled some but not all is "partial", never silently upgraded.
  const verified = settleable.length > 0 && settled.length === settleable.length;

  const mergedEvidence: string[] = [];
  const seen = new Set<string>();
  for (const item of [
    ...(Array.isArray(base.evidence) ? base.evidence : []),
    ...(Array.isArray(evidence) ? evidence : []),
  ]) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    mergedEvidence.push(trimmed);
  }

  return {
    ...base,
    identity: { ...base.identity },
    controls,
    limits: { ...base.limits },
    limitations: [...base.limitations],
    declared: true,
    verified,
    partial: !verified && settled.length > 0,
    verifiedControls: settled,
    evidence: mergedEvidence,
    unknown,
  };
}
