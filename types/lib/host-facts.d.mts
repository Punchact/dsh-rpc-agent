import type { CapabilitySectionId, CollectedCapabilitySection } from "./capabilities.mjs";

export declare function collectFacts(options?: {
  ctx?: unknown;
  config?: Record<string, unknown>;
  state?: Record<string, unknown>;
  sessionId?: string | null;
  sections?: CapabilitySectionId[] | string[] | "*" | null;
}): Promise<CollectedCapabilitySection[]>;
