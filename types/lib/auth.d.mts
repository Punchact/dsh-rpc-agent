export interface PublishedEndpoint {
  url: string;
  origin?: string;
  path?: string;
  version?: string;
  plugin?: string;
  pid?: number;
  startedAt?: string;
  updatedAt?: string;
}

export declare const MIN_TOKEN_LENGTH: number;
export declare function dshHome(env?: Record<string, string | undefined>): string;
export declare function stateDir(env?: Record<string, string | undefined>): string;
export declare function tokenPath(config?: { tokenFile?: string }, env?: Record<string, string | undefined>): string;
export declare function endpointPath(env?: Record<string, string | undefined>): string;
export declare function tokenMatches(expected: unknown, presented: unknown): boolean;
export declare function extractToken(headers: Record<string, string | string[] | undefined> | undefined): string;
export declare function readEndpoint(env?: Record<string, string | undefined>): PublishedEndpoint | null;
export declare function readTokenFromFile(
  config?: { tokenFile?: string },
  env?: Record<string, string | undefined>,
): string | null;
