// Contract tests for the sticky-session registry.
//
// What matters here is not the file format but the four properties the field
// failure depended on: the key separates clients, a lost file is not an error,
// a write is all-or-nothing, and the use counter only advances for the session it
// belongs to.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// `registryPath()` reads `$DSH_HOME` on every call, so pointing it at a scratch
// directory keeps the real profile's registry out of the test entirely.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-rpc-registry-"));

const { REGISTRY_VERSION, forgetEntry, lookupEntry, readRegistry, registryKey, registryPath, rememberEntry, writeRegistry, ROTATE_AFTER_ASKS } =
  await import("../lib/registry.mjs");

test("the key separates clients and prefers a project over a directory", () => {
  assert.equal(registryKey({ namespace: "codex", project: "workbuddy" }), "codex::workbuddy");
  assert.equal(registryKey({ namespace: "codex", cwd: "C:/work/a" }), "codex::C:/work/a");
  // A project wins, so the same project from two checkouts lands in one session.
  assert.equal(registryKey({ namespace: "codex", project: "p", cwd: "C:/work/a" }), "codex::p");
  // Two clients with the same project never share.
  assert.notEqual(registryKey({ namespace: "codex", project: "p" }), registryKey({ namespace: "claude", project: "p" }));
  // No scope at all → no key, which is how "no sticky behaviour" is expressed.
  assert.equal(registryKey({ namespace: "codex" }), null);
  assert.equal(registryKey({}), null);
  // A missing namespace falls back to the documented default.
  assert.equal(registryKey({ project: "p" }), "mcp::p");
});

test("a missing registry reads as empty instead of throwing", async () => {
  const empty = await readRegistry(join(process.env.DSH_HOME, "dsh-rpc", "never-written.json"));
  assert.deepEqual(empty, { version: REGISTRY_VERSION, sessions: {} });
});

test("a corrupt registry degrades to empty instead of failing the call", async () => {
  const file = join(process.env.DSH_HOME, "corrupt.json");
  writeFileSync(file, "{ this is not json");
  assert.deepEqual(await readRegistry(file), { version: REGISTRY_VERSION, sessions: {} });
  writeFileSync(file, JSON.stringify({ version: 1, sessions: [] }));
  assert.deepEqual(await readRegistry(file), { version: REGISTRY_VERSION, sessions: {} });
});

test("an entry round-trips, and each remember bumps that session's counter", async () => {
  const file = join(process.env.DSH_HOME, "roundtrip.json");
  const key = registryKey({ namespace: "codex", project: "p1" });
  const first = await rememberEntry(key, { sessionId: "session-a", project: "p1", cwd: "/w" }, file);
  assert.equal(first.asks, 1);
  assert.equal(first.sessionId, "session-a");
  assert.match(first.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const second = await rememberEntry(key, { sessionId: "session-a" }, file);
  assert.equal(second.asks, 2);

  const found = await lookupEntry(key, file);
  assert.equal(found.sessionId, "session-a");
  assert.equal(found.asks, 2);

  // A different session under the same key is a new mapping, not a continuation.
  const rotated = await rememberEntry(key, { sessionId: "session-b" }, file);
  assert.equal(rotated.asks, 1);
  assert.equal((await lookupEntry(key, file)).sessionId, "session-b");
});

test("different keys do not collide, and forget removes exactly one", async () => {
  const file = join(process.env.DSH_HOME, "multi.json");
  await rememberEntry("codex::a", { sessionId: "s-a" }, file);
  await rememberEntry("codex::b", { sessionId: "s-b" }, file);
  assert.equal((await lookupEntry("codex::a", file)).sessionId, "s-a");
  assert.equal(await forgetEntry("codex::a", file), true);
  assert.equal(await lookupEntry("codex::a", file), null);
  assert.equal((await lookupEntry("codex::b", file)).sessionId, "s-b");
  // Forgetting what is not there is not an error.
  assert.equal(await forgetEntry("codex::a", file), false);
});

test("the written file is complete JSON even when rewritten many times", async () => {
  const file = join(process.env.DSH_HOME, "atomic.json");
  for (let index = 0; index < 25; index += 1) {
    await rememberEntry(`mcp::p${index % 3}`, { sessionId: `s-${index}` }, file);
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.version, REGISTRY_VERSION);
  for (const key of ["mcp::p0", "mcp::p1", "mcp::p2"]) {
    assert.equal(typeof parsed.sessions[key].sessionId, "string");
  }
  // No temp files left behind by the atomic replace.
  const { readdirSync } = await import("node:fs");
  const dir = process.env.DSH_HOME;
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes(".tmp")),
    [],
  );
});

test("the rotation threshold is a bridge-side ask count, not a Host message count", async () => {
  assert.equal(ROTATE_AFTER_ASKS, 200);
  const file = join(process.env.DSH_HOME, "rotate.json");
  await rememberEntry("mcp::big", { sessionId: "s-big", asks: ROTATE_AFTER_ASKS - 1 }, file);
  const bumped = await rememberEntry("mcp::big", { sessionId: "s-big" }, file);
  assert.equal(bumped.asks, ROTATE_AFTER_ASKS);
});

test("an explicit write is atomic and keeps the documented shape", async () => {
  const file = join(process.env.DSH_HOME, "explicit.json");
  await writeRegistry({ version: REGISTRY_VERSION, sessions: { "mcp::x": { sessionId: "s-x" } } }, file);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    version: REGISTRY_VERSION,
    sessions: { "mcp::x": { sessionId: "s-x" } },
  });
  // The default path lives under $DSH_HOME/dsh-rpc, next to endpoint.json.
  assert.equal(registryPath().endsWith(join("dsh-rpc", "sessions.json")), true);
});
