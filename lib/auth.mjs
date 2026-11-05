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

export function dshHome(env = process.env) {
  const explicit = env.DSH_HOME?.trim();
  if (explicit) return explicit;
  return join(homedir(), ".dsh");
}

export function stateDir(env = process.env) {
  return join(dshHome(env), "dsh-rpc");
}

export function tokenPath(config = {}, env = process.env) {
  const explicit = typeof config.tokenFile === "string" ? config.tokenFile.trim() : "";
  return explicit ? explicit : join(stateDir(env), "token");
}

export function endpointPath(env = process.env) {
  return join(stateDir(env), "endpoint.json");
}

function readText(path) {
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
export function loadOrCreateToken(config = {}, env = process.env) {
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
  } catch (error) {
    if (error?.code === "EEXIST") {
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
export function tokenMatches(expected, presented) {
  if (typeof presented !== "string" || presented.length === 0) return false;
  if (typeof expected !== "string" || expected.length === 0) return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Accept `Authorization: Bearer <token>` or `X-DSH-RPC-Token: <token>`. */
export function extractToken(headers) {
  const auth = headers?.authorization;
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
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

export function writeEndpoint({ url, origin, path, version }, env = process.env) {
  const target = endpointPath(env);
  const payload = {
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

export function readEndpoint(env = process.env) {
  const raw = readText(endpointPath(env));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function readTokenFromFile(config = {}, env = process.env) {
  return readText(tokenPath(config, env))?.trim() || null;
}
