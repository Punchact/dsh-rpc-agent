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
] as const);

export type CapabilitySectionId = (typeof SECTION_IDS)[number];

export type CapabilitySectionStatus = "ok" | "partial" | "unavailable";

const SECTION_SET: ReadonlySet<string> = new Set(SECTION_IDS);

export const DEFAULT_MAX_CHARS = 8000;
export const MAX_MAX_CHARS = 40000;
const TRUNCATION_LINE = "… truncated (raise max_chars to see the rest)";

export interface CollectedCapabilitySection {
  id: string;
  status: CapabilitySectionStatus | string;
  source: string;
  lines?: string[];
  reason?: string;
  data?: unknown;
}

export interface NormalizedSectionsResult {
  sections: CapabilitySectionId[];
  missing: string[];
}

export interface NormalizedCapabilitySection {
  id: string;
  status: CapabilitySectionStatus;
  source: string;
  lines?: string[];
  reason?: string;
  data?: unknown;
}

export interface FormatCapabilitiesOptions {
  maxChars?: number | undefined;
  missing?: string[] | undefined;
}

export interface FormattedCapabilitiesStructured {
  plugin: string;
  version: string;
  protocol: string;
  counts: {
    ok: number;
    partial: number;
    unavailable: number;
    total: number;
  };
  sections: NormalizedCapabilitySection[];
  shown: string[];
  missing: string[];
  truncated: boolean;
}

export interface FormattedCapabilities {
  text: string;
  structured: FormattedCapabilitiesStructured;
  shown: string[];
  missing: string[];
  truncated: boolean;
}

function oneLine(value: unknown): string {
  return String(value ?? "").replace(/\r?\n|\r/g, " ").trim();
}

function resolveMaxChars(value: unknown): number {
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
export function normalizeSections(value: unknown): NormalizedSectionsResult {
  if (value === null || value === undefined || value === "*") {
    return { sections: [...SECTION_IDS], missing: [] };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "*") return { sections: [...SECTION_IDS], missing: [] };
    return SECTION_SET.has(trimmed)
      ? { sections: [trimmed as CapabilitySectionId], missing: [] }
      : { sections: [], missing: [trimmed] };
  }
  if (!Array.isArray(value)) {
    return { sections: [...SECTION_IDS], missing: [] };
  }
  if (value.length === 0) {
    return { sections: [...SECTION_IDS], missing: [] };
  }

  const seen = new Set<CapabilitySectionId>();
  const missing = new Set<string>();
  let wildcard = false;

  for (const item of value) {
    const id = typeof item === "string" ? item.trim() : String(item ?? "").trim();
    if (!id) continue;
    if (id === "*") {
      wildcard = true;
      continue;
    }
    if (SECTION_SET.has(id)) {
      seen.add(id as CapabilitySectionId);
    } else {
      missing.add(id);
    }
  }

  if (wildcard) {
    return { sections: [...SECTION_IDS], missing: [...missing] };
  }
  return { sections: [...seen], missing: [...missing] };
}

function applyMaxChars(lines: string[], maxChars: number): { text: string; truncated: boolean } {
  const full = lines.join("\n");
  if (maxChars === 0 || full.length <= maxChars) {
    return { text: full, truncated: false };
  }
  if (maxChars <= TRUNCATION_LINE.length) {
    return { text: TRUNCATION_LINE.slice(0, maxChars), truncated: true };
  }

  const budget = maxChars - TRUNCATION_LINE.length - 1;
  const kept: string[] = [];
  let used = 0;

  for (const line of lines) {
    const needed = kept.length === 0 ? line.length : line.length + 1;
    if (used + needed > budget) break;
    kept.push(line);
    used += needed;
  }

  if (kept.length === 0 && lines.length > 0) {
    // lines.length > 0 checked immediately above.
    kept.push((lines[0] as string).slice(0, budget));
  }
  kept.push(TRUNCATION_LINE);
  return { text: kept.join("\n"), truncated: true };
}

/**
 * Format collected capability sections into bounded text and structured output.
 */
export function formatCapabilities(
  sections: CollectedCapabilitySection[] | unknown,
  options: FormatCapabilitiesOptions = {},
): FormattedCapabilities {
  const list = Array.isArray(sections) ? (sections as CollectedCapabilitySection[]) : [];
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
  const normalizedSections: NormalizedCapabilitySection[] = [];

  for (const section of list) {
    const id = typeof section?.id === "string" && section.id ? section.id : "unknown";
    const status: CapabilitySectionStatus =
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
    const cleanLines: string[] = [];
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

  const structured: FormattedCapabilitiesStructured = {
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
