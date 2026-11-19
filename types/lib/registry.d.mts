export declare const REGISTRY_VERSION: number;
export declare const DEFAULT_NAMESPACE: string;
export declare const ROTATE_AFTER_ASKS: number;

export interface StickyRegistryEntry {
  key: string;
  sessionId: string;
  project?: string | null;
  cwd?: string | null;
  previousSessionId?: string | null;
  asks?: number;
  updatedAt?: string;
}

export interface StickyRegistryRecordInput {
  sessionId: string;
  project?: string | null;
  cwd?: string | null;
  previousSessionId?: string | null;
  asks?: number;
}

export declare function registryPath(env?: NodeJS.ProcessEnv): string;

export declare function registryKey(options?: {
  namespace?: string | null;
  project?: string | null;
  cwd?: string | null;
}): string | null;

export declare function readRegistry(file?: string): Promise<{
  version: number;
  sessions: Record<string, Omit<StickyRegistryEntry, "key">>;
}>;

export declare function writeRegistry(
  registry: { version: number; sessions: Record<string, unknown> },
  file?: string,
): Promise<string>;

export declare function lookupEntry(key: string | null, file?: string): Promise<StickyRegistryEntry | null>;

export declare function rememberEntry(
  key: string | null,
  entry: StickyRegistryRecordInput,
  file?: string,
): Promise<StickyRegistryEntry | null>;

export declare function forgetEntry(key: string | null, file?: string): Promise<boolean>;
