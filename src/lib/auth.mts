// Shared-secret handling for the loopback RPC bridge, plus the small on-disk
// contract that external agents (CLI, MCP bridge, ad-hoc curl) use to discover
// the endpoint. Files live under `$DSH_HOME/dsh-rpc/`:
//
//   token          the bearer secret, 64 hex chars, mode 0600
//   endpoint.json  { url, origin, path, version, updatedAt }
//
// The plugin creates them on activation; readers never mutate them.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ConfigError } from "./config.mjs";
import { PLUGIN_NAME } from "./version.mjs";

export const MIN_TOKEN_LENGTH = 16;

export type TokenSource = "config" | "env" | "file" | "generated";

export interface AuthConfigInput {
  token?: string | undefined;
  tokenFile?: string | undefined;
}

export interface LoadOrCreateTokenResult {
  token: string;
  source: TokenSource;
  path: string | null;
}

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

export interface WriteEndpointOptions {
  url: string;
  origin: string;
  path: string;
  version: string;
}

export interface WriteEndpointResult {
  path: string;
  payload: Required<PublishedEndpoint>;
}

export function dshHome(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.DSH_HOME?.trim();
  if (explicit) return explicit;
  return join(homedir(), ".dsh");
}

export function stateDir(env: Record<string, string | undefined> = process.env): string {
  return join(dshHome(env), "dsh-rpc");
}

export function tokenPath(
  config: AuthConfigInput = {},
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = typeof config.tokenFile === "string" ? config.tokenFile.trim() : "";
  return explicit ? explicit : join(stateDir(env), "token");
}

export function endpointPath(env: Record<string, string | undefined> = process.env): string {
  return join(stateDir(env), "endpoint.json");
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve the bearer token. Precedence: explicit config, then `DSH_RPC_TOKEN`,
 * then the persisted file, then a freshly generated secret that is written back
 * so later CLI/MCP invocations find the same value.
 */
export function loadOrCreateToken(
  config: AuthConfigInput = {},
  env: Record<string, string | undefined> = process.env,
): LoadOrCreateTokenResult {
  const configured = typeof config.token === "string" ? config.token.trim() : "";
  if (configured) {
    if (configured.length < MIN_TOKEN_LENGTH) {
      throw new ConfigError([`token: must be at least ${MIN_TOKEN_LENGTH} characters`]);
    }
    return { token: configured, source: "config", path: null };
  }

  const fromEnv = env.DSH_RPC_TOKEN?.trim();
  if (fromEnv) {
    if (fromEnv.length < MIN_TOKEN_LENGTH) {
      throw new ConfigError([`DSH_RPC_TOKEN: must be at least ${MIN_TOKEN_LENGTH} characters`]);
    }
    return { token: fromEnv, source: "env", path: null };
  }

  const path = tokenPath(config, env);
  const existing = readText(path)?.trim();
  if (existing) {
    if (existing.length < MIN_TOKEN_LENGTH) {
      throw new ConfigError([
        `token file ${path}: holds ${existing.length} characters, need at least ${MIN_TOKEN_LENGTH}; delete it to generate a new secret`,
      ]);
    }
    return { token: existing, source: "file", path };
  }

  const token = randomBytes(32).toString("hex");
  mkdirSync(stateDir(env), { recursive: true });
  try {
    // `wx` refuses to clobber a secret another process wrote between the read
    // above and this write, which would leave two instances with different tokens.
    writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error: unknown) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "EEXIST") {
      const winner = readText(path)?.trim();
      if (winner && winner.length >= MIN_TOKEN_LENGTH) return { token: winner, source: "file", path };
      throw new ConfigError([`token file ${path}: raced with another writer and is unusable; delete it and retry`]);
    }
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and some network shares report no POSIX mode; the file is still
    // inside the user's own profile directory.
  }
  return { token, source: "generated", path };
}

/** Constant-time comparison over fixed-length digests. */
export function tokenMatches(expected: unknown, presented: unknown): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  if (typeof expected !== "string" || expected.length === 0) return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Accept `Authorization: Bearer <token>` or `X-DSH-RPC-Token: <token>`. */
export function extractToken(
  headers: Record<string, string | string[] | undefined> | undefined,
): string {
  const auth = headers?.authorization;
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    // Capture group 1 (.+) is guaranteed to be a string when the regex matches.
    if (match) return (match[1] as string).trim();
  }
  const header = headers?.["x-dsh-rpc-token"];
  if (typeof header === "string") return header.trim();
  return "";
}

// The Host process start time, captured once. A client that remembers an older
// endpoint can compare this against what it sees now and tell "the Harness
// restarted on a new port" apart from "my request was malformed" — which is the
// difference between retrying and reporting.
const PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

export function writeEndpoint(
  { url, origin, path, version }: WriteEndpointOptions,
  env: Record<string, string | undefined> = process.env,
): WriteEndpointResult {
  const target = endpointPath(env);
  const payload: Required<PublishedEndpoint> = {
    url,
    origin,
    path,
    version,
    plugin: PLUGIN_NAME,
    pid: process.pid,
    startedAt: PROCESS_STARTED_AT,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(stateDir(env), { recursive: true });
  // Write-then-rename: a CLI reading the file must never see a half-written
  // JSON document, which would look like "no endpoint" instead of a transient.
  const staging = `${target}.${process.pid}.tmp`;
  writeFileSync(staging, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(staging, target);
  return { path: target, payload };
}

export function readEndpoint(env: Record<string, string | undefined> = process.env): PublishedEndpoint | null {
  const raw = readText(endpointPath(env));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as PublishedEndpoint) : null;
  } catch {
    return null;
  }
}

export function readTokenFromFile(
  config: AuthConfigInput = {},
  env: Record<string, string | undefined> = process.env,
): string | null {
  return readText(tokenPath(config, env))?.trim() || null;
}
