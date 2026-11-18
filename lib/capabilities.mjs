// Pure projection of collected Harness capability facts into bounded human text
// and structured metadata, without calling `ctx.get(...)` or performing I/O.

import { PLUGIN_NAME, PLUGIN_VERSION, PROTOCOL_VERSION } from "./version.mjs";

export const SECTION_IDS = Object.freeze([
  "identity",
  "runtime",
  "permissions",
  "tools",
  "mcp",
  "sessions",
  "workspace",
  "plugins",
]);

const SECTION_SET = new Set(SECTION_IDS);

export const DEFAULT_MAX_CHARS = 8000;
export const MAX_MAX_CHARS = 40000;
const TRUNCATION_LINE = "… truncated (raise max_chars to see the rest)";

function oneLine(value) {
  return String(value ?? "").replace(/\r?\n|\r/g, " ").trim();
}

function resolveMaxChars(value) {
  if (value === 0) return 0;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(Math.floor(value), MAX_MAX_CHARS);
  }
  return DEFAULT_MAX_CHARS;
}

/**
 * Normalize a requested section filter (`null`, `[]`, `["*"]`, or a subset).
 * Unknown ids are ignored and returned in `missing`; valid ids appear once.
 */
export function normalizeSections(value) {
  if (value === null || value === undefined || value === "*") {
    return { sections: [...SECTION_IDS], missing: [] };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "*") return { sections: [...SECTION_IDS], missing: [] };
    return SECTION_SET.has(trimmed)
      ? { sections: [trimmed], missing: [] }
      : { sections: [], missing: [trimmed] };
  }
  if (!Array.isArray(value)) {
    return { sections: [...SECTION_IDS], missing: [] };
  }
  if (value.length === 0) {
    return { sections: [...SECTION_IDS], missing: [] };
  }

  const seen = new Set();
  const missing = new Set();
  let wildcard = false;

  for (const item of value) {
    const id = typeof item === "string" ? item.trim() : String(item ?? "").trim();
    if (!id) continue;
    if (id === "*") {
      wildcard = true;
      continue;
    }
    if (SECTION_SET.has(id)) {
      seen.add(id);
    } else {
      missing.add(id);
    }
  }

  if (wildcard) {
    return { sections: [...SECTION_IDS], missing: [...missing] };
  }
  return { sections: [...seen], missing: [...missing] };
}

function applyMaxChars(lines, maxChars) {
  const full = lines.join("\n");
  if (maxChars === 0 || full.length <= maxChars) {
    return { text: full, truncated: false };
  }
  if (maxChars <= TRUNCATION_LINE.length) {
    return { text: TRUNCATION_LINE.slice(0, maxChars), truncated: true };
  }

  const budget = maxChars - TRUNCATION_LINE.length - 1;
  const kept = [];
  let used = 0;

  for (const line of lines) {
    const needed = kept.length === 0 ? line.length : line.length + 1;
    if (used + needed > budget) break;
    kept.push(line);
    used += needed;
  }

  if (kept.length === 0 && lines.length > 0) {
    kept.push(lines[0].slice(0, budget));
  }
  kept.push(TRUNCATION_LINE);
  return { text: kept.join("\n"), truncated: true };
}

/**
 * Format collected capability sections into bounded text and structured output.
 */
export function formatCapabilities(sections, options = {}) {
  const list = Array.isArray(sections) ? sections : [];
  const missing = Array.isArray(options.missing) ? [...options.missing] : [];
  const maxChars = resolveMaxChars(options.maxChars);

  let ok = 0;
  let partial = 0;
  let unavailable = 0;

  for (const section of list) {
    if (section?.status === "ok") ok += 1;
    else if (section?.status === "partial") partial += 1;
    else unavailable += 1;
  }

  const noun = list.length === 1 ? "section" : "sections";
  const header =
    `capabilities: ${PLUGIN_NAME} ${PLUGIN_VERSION} · protocol ${PROTOCOL_VERSION} · ` +
    `${list.length} ${noun} (${ok} ok · ${partial} partial · ${unavailable} unavailable)`;

  const lines = [header];
  const normalizedSections = [];

  for (const section of list) {
    const id = typeof section?.id === "string" && section.id ? section.id : "unknown";
    const status =
      section?.status === "ok" || section?.status === "partial" || section?.status === "unavailable"
        ? section.status
        : "unavailable";
    const source = typeof section?.source === "string" && section.source ? section.source : "unknown";

    if (status === "unavailable") {
      const reason = oneLine(section?.reason || "unavailable");
      lines.push(`${id} [unavailable] — ${reason}`);
      normalizedSections.push({
        id,
        status,
        source,
        reason,
        ...(section?.data !== undefined ? { data: section.data } : {}),
      });
      continue;
    }

    lines.push(`${id} [${status}] source: ${source}`);
    const rawLines = Array.isArray(section?.lines) && section.lines.length > 0 ? section.lines : ["(no details)"];
    const cleanLines = [];
    for (const rawLine of rawLines) {
      for (const part of String(rawLine ?? "").split(/\r?\n/)) {
        cleanLines.push(part);
        lines.push(`  ${part}`);
      }
    }
    normalizedSections.push({
      id,
      status,
      source,
      lines: cleanLines,
      ...(section?.data !== undefined ? { data: section.data } : {}),
    });
  }

  const { text, truncated } = applyMaxChars(lines, maxChars);
  const shown = normalizedSections.map((section) => section.id);

  const structured = {
    plugin: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    protocol: PROTOCOL_VERSION,
    counts: { ok, partial, unavailable, total: normalizedSections.length },
    sections: normalizedSections,
    shown,
    missing,
    truncated,
  };

  return { text, structured, shown, missing, truncated };
}
