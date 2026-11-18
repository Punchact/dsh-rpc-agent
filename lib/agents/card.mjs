// Agent capability card (L1, §4.2): declared != verified.
// Cards are normalized and hashed deterministically; `verified: true` can only
// be produced via `withVerified(...)` after a real probe run.

import { createHash } from "node:crypto";

import { TASK_ERROR, taskError } from "../tasks/errors.mjs";

export const CARD_VERSION = "capability-card@1";

export const CONTROL_NAMES = Object.freeze([
  "start",
  "steer",
  "cancel",
  "inspect",
  "approval",
  "events",
]);

export const CONTROL_SUPPORTS = Object.freeze(["required", "optional", "unsupported"]);

const CONTROL_NAME_SET = new Set(CONTROL_NAMES);
const CONTROL_SUPPORT_SET = new Set(CONTROL_SUPPORTS);
const LIMIT_KEYS = new Set(["maxConcurrent", "maxRuntimeMs", "maxInputChars"]);

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

function invalidCard(message, data = {}) {
  return taskError(TASK_ERROR.INVALID_CARD, message, data);
}

function requireNonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidCard(`card.${path} must be a non-empty string`, { path });
  }
  return value.trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate and normalize an agent capability card.
 * Enforces declared != verified: `normalizeCard` always yields `declared: true, verified: false`.
 */
export function normalizeCard(input) {
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
  const identity = {
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
  const controls = {};
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
      support: entry.support,
      evidence: entry.evidence.trim(),
    };
  }

  const limits = {};
  if (input.limits !== undefined) {
    if (!isPlainObject(input.limits)) {
      throw invalidCard("card.limits must be an object when provided", { path: "limits" });
    }
    for (const [key, val] of Object.entries(input.limits)) {
      if (!LIMIT_KEYS.has(key)) {
        throw invalidCard(`unknown limit key "${key}" in card.limits`, { path: `limits.${key}` });
      }
      if (val !== undefined) {
        if (!Number.isInteger(val) || val <= 0) {
          throw invalidCard(`card.limits.${key} must be a positive integer`, { path: `limits.${key}` });
        }
        limits[key] = val;
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

  return {
    cardVersion: CARD_VERSION,
    identity,
    controls,
    limits,
    limitations,
    declared: true,
    verified: false,
  };
}

/**
 * Compute a deterministic sha256 digest of a card regardless of object key ordering.
 */
export function hashCard(card) {
  return createHash("sha256").update(stableStringify(card)).digest("hex");
}

/**
 * Return a verified copy of `card` after a probe run without mutating the
 * declared `controls[*].support` postures. Unsettled controls land in `unknown[]`.
 *
 * @param {object} card Normalized card
 * @param {object} verifiedControls Map like `{ start: true, cancel: true }` (or `{ verified, unknown }`)
 * @param {string[]} [evidence=[]] Probe evidence strings to merge
 */
export function withVerified(card, verifiedControls = {}, evidence = []) {
  const base = card?.cardVersion === CARD_VERSION && card?.declared === true ? card : normalizeCard(card);
  const settledMap = isPlainObject(verifiedControls?.verified) ? verifiedControls.verified : verifiedControls;
  const isSettled = (name) =>
    settledMap?.[name] === true ||
    (isPlainObject(settledMap?.[name]) && settledMap[name].verified === true);

  const controls = {};
  const unknown = [];
  const settled = [];

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

  const mergedEvidence = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(base.evidence) ? base.evidence : []), ...(Array.isArray(evidence) ? evidence : [])]) {
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
