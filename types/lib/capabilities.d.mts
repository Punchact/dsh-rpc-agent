export declare const SECTION_IDS: readonly [
  "identity",
  "runtime",
  "permissions",
  "tools",
  "mcp",
  "sessions",
  "workspace",
  "plugins",
];

export type CapabilitySectionId = (typeof SECTION_IDS)[number];

export declare const DEFAULT_MAX_CHARS: number;
export declare const MAX_MAX_CHARS: number;

export interface CollectedCapabilitySection {
  id: string;
  status: "ok" | "partial" | "unavailable";
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
  status: "ok" | "partial" | "unavailable";
  source: string;
  lines?: string[];
  reason?: string;
  data?: unknown;
}

export interface FormattedCapabilities {
  text: string;
  structured: {
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
  };
  shown: string[];
  missing: string[];
  truncated: boolean;
}

export declare function normalizeSections(value: unknown): NormalizedSectionsResult;

export declare function formatCapabilities(
  sections: CollectedCapabilitySection[],
  options?: {
    maxChars?: number;
    missing?: string[];
  },
): FormattedCapabilities;
