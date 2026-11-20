// Executor session stickiness (§8.1 / 0.9.5-e).
//
// The map remembers "which remote conversation is this agent/workspace pair using"
// across Host restarts. Every case here is about what survives — a wrong read costs
// a fresh thread, never a task — so the tests assert the file format, not internals.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  STICKY_MAX_ENTRIES,
  createStickySessions,
  defaultStickyFile,
  stickyKey,
} from "../dist/lib/adapters/sticky.mjs";

const KEY = { kind: "codex", agentId: "agent-a", workspaceId: "ws-a" };

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "sticky-")), "executor-sessions.json");
}

test("a remembered session outlives the instance that wrote it", () => {
  const file = tempFile();
  createStickySessions({ file }).remember(KEY, "thr-1");

  // A Host restart throws the in-memory cache away; the file is the memory.
  const reopened = createStickySessions({ file });
  assert.equal(reopened.get(KEY), "thr-1");
  assert.deepEqual(reopened.entries(), { "codex:agent-a:ws-a": "thr-1" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).sessions["codex:agent-a:ws-a"].id, "thr-1");
});

test("keys carry the adapter kind, so two executors never share a session", () => {
  const file = tempFile();
  const sticky = createStickySessions({ file });
  sticky.remember({ kind: "codex", agentId: "a", workspaceId: "w" }, "thr-codex");
  sticky.remember({ kind: "antigravity", agentId: "a", workspaceId: "w" }, "cascade-ag");

  assert.equal(sticky.get({ kind: "codex", agentId: "a", workspaceId: "w" }), "thr-codex");
  assert.equal(sticky.get({ kind: "antigravity", agentId: "a", workspaceId: "w" }), "cascade-ag");
  assert.equal(stickyKey({ kind: "codex", agentId: "a", workspaceId: "w" }), "codex:a:w");
});

test("forgetting a session makes the next turn start over", () => {
  const file = tempFile();
  const sticky = createStickySessions({ file });
  sticky.remember(KEY, "thr-1");
  sticky.forget(KEY);

  assert.equal(sticky.get(KEY), null);
  assert.deepEqual(createStickySessions({ file }).entries(), {});
});

test("a corrupt map reads as empty instead of throwing", () => {
  const file = tempFile();
  writeFileSync(file, "{ not json", "utf8");

  const sticky = createStickySessions({ file });
  assert.equal(sticky.get(KEY), null);
  assert.deepEqual(sticky.entries(), {});

  // Writing after a corrupt read must produce a valid document again.
  sticky.remember(KEY, "thr-2");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).sessions["codex:agent-a:ws-a"].id, "thr-2");
});

test("empty ids are refused, and a disabled store never touches the disk", () => {
  const file = tempFile();
  const sticky = createStickySessions({ file });
  sticky.remember(KEY, "");
  assert.equal(sticky.get(KEY), null);

  const disabled = createStickySessions({ file, enabled: false });
  disabled.remember(KEY, "thr-3");
  assert.equal(disabled.get(KEY), null);
  assert.equal(sticky.get(KEY), null, "the disabled store wrote nothing");
});

test("the map stays bounded, keeping the most recently used entries", () => {
  const file = tempFile();
  let now = 1_000;
  const sticky = createStickySessions({ file, now: () => now });
  const total = STICKY_MAX_ENTRIES + 5;
  for (let i = 0; i < total; i += 1) {
    now += 1;
    sticky.remember({ kind: "codex", agentId: `agent-${i}`, workspaceId: "ws" }, `thr-${i}`);
  }

  // `dist` is compiled JavaScript, so the inferred return is `{}` rather than the source
  // interface; assert the contract here instead of at every call site.
  const entries = sticky.entries() as unknown as Record<string, string>;
  assert.equal(Object.keys(entries).length, STICKY_MAX_ENTRIES);
  assert.equal(entries[`codex:agent-${total - 1}:ws`], `thr-${total - 1}`, "newest kept");
  assert.equal(entries["codex:agent-0:ws"], undefined, "oldest dropped");
});

test("the default map lives beside the task ledger, not inside it", () => {
  assert.match(defaultStickyFile(), /[\\/]\.dsh[\\/]storages[\\/]task-center[\\/]executor-sessions\.json$/);
});
