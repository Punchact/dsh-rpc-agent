// Sticky sessions: "one project, one session", remembered across calls.
//
// The reason this file exists is the field failure in `dsh-rpc-异步作业改造方案.md`
// §1: a caller whose tool timeout is 300 s cannot keep a session id in hand, and
// the session id only ever existed in the *return value* of the call that timed
// out. Re-asking then created a new session every time — four sessions for one
// task, each starting from zero.
//
// So the mapping "this client, this project → that session" has to live somewhere
// durable on the bridge side, and it has to be cheap to read on every ask.
//
// Deliberate properties:
//   * one JSON file, small, read per call — no cache to invalidate, no daemon;
//   * atomic replace (write `.tmp` + rename), 0600, so a crashed write cannot
//     leave a half-parsed file that would silently forget every mapping;
//   * a corrupt or unreadable file degrades to "no mappings" rather than
//     throwing: losing the shortcut must never fail the call itself.
//
// The key is `namespace::project` where `namespace` is the MCP client's
// `clientInfo.name`. Two different agents driving the same directory therefore do
// not steal each other's session.

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { stateDir } from "./auth.mjs";

export const REGISTRY_VERSION = 1;
export const DEFAULT_NAMESPACE = "mcp";

/**
 * Rotate a sticky session after this many asks *from this bridge*.
 *
 * The plan wanted the Host's `messageCount`, but the Host exposes no cheap total:
 * `dsh.sessions.history` reports `records.length` of a windowed snapshot, so
 * asking "is this session huge?" would mean loading up to the threshold in
 * messages on every single ask. Counting our own deliveries is O(1), monotonic,
 * and the thing we actually control — and it is the number that grows one per
 * turn we add anyway. Documented as a proxy, not as the Host's message count.
 */
export const ROTATE_AFTER_ASKS = 200;

export function registryPath(env = process.env) {
  return join(stateDir(env), "sessions.json");
}

/**
 * `namespace::scope`, or null when there is no scope to key on.
 *
 * `project` wins over `cwd` on purpose: a project may be worked on from several
 * checkouts, and the caller that names a project is asking for exactly that.
 */
export function registryKey({ namespace, project, cwd } = {}) {
  const ns = typeof namespace === "string" && namespace.trim() ? namespace.trim() : DEFAULT_NAMESPACE;
  const scope = (typeof project === "string" && project.trim()) || (typeof cwd === "string" && cwd.trim()) || "";
  return scope ? `${ns}::${scope}` : null;
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, sessions: {} };
}

export async function readRegistry(file = registryPath()) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return emptyRegistry();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyRegistry();
  }
  if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object") {
    return emptyRegistry();
  }
  return { version: REGISTRY_VERSION, sessions: { ...parsed.sessions } };
}

export async function writeRegistry(registry, file = registryPath()) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600, encoding: "utf8" });
  try {
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  // rename keeps the mode of the temp file, but be explicit for platforms that
  // do not: the file names the sessions this bridge will drive next.
  await chmod(file, 0o600).catch(() => {});
  return file;
}

export async function lookupEntry(key, file = registryPath()) {
  if (!key) return null;
  const registry = await readRegistry(file);
  const entry = registry.sessions[key];
  if (!entry || typeof entry !== "object" || typeof entry.sessionId !== "string") return null;
  return { key, ...entry };
}

/**
 * Record (or refresh) a mapping and bump its use counter in one atomic write.
 * Returns the stored entry so the caller can report `asks`/rotation state.
 */
export async function rememberEntry(key, entry, file = registryPath()) {
  if (!key) return null;
  const registry = await readRegistry(file);
  const previous = registry.sessions[key];
  const asks = Number.isInteger(entry.asks)
    ? entry.asks
    : Number.isInteger(previous?.asks) && previous?.sessionId === entry.sessionId
      ? previous.asks + 1
      : 1;
  const stored = { ...entry, asks, updatedAt: new Date().toISOString() };
  registry.sessions[key] = stored;
  await writeRegistry(registry, file);
  return { key, ...stored };
}

export async function forgetEntry(key, file = registryPath()) {
  if (!key) return false;
  const registry = await readRegistry(file);
  if (!(key in registry.sessions)) return false;
  delete registry.sessions[key];
  await writeRegistry(registry, file);
  return true;
}
