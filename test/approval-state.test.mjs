import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApprovalGate } from "../lib/approvals.mjs";
import { createApprovalState } from "../lib/approval-state.mjs";
import { createPendingStore } from "../lib/pending.mjs";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-approval-state-"));
  return { dir, file: join(dir, "approvals.json") };
}

const quiet = { info() {}, warn() {} };

test("allowances, ownership and the widen journal survive a restart", () => {
  const { file } = scratch();
  const first = createApprovalState({ file, log: quiet });
  first.allowances.set("session-a", 2);
  first.owned.set("session-a");
  first.widened.set("session-b", "read-only");

  const second = createApprovalState({ file, log: quiet });
  assert.equal(second.allowances.get("session-a"), 2, "an allowance is not refilled by a restart");
  assert.equal(second.owned.has("session-a"), true, "ownership outlives the process");
  assert.equal(second.widened.get("session-b"), "read-only");
  assert.deepEqual(second.pendingWidens(), [{ sessionId: "session-b", previous: "read-only" }]);
  assert.deepEqual([...second.widened], [["session-b", "read-only"]]);
});

test("a corrupt file degrades to empty instead of throwing", () => {
  const { dir, file } = scratch();
  writeFileSync(file, "{ not json", "utf8");
  const state = createApprovalState({ file, log: quiet });
  assert.equal(state.allowances.get("anything"), undefined);
  assert.deepEqual(state.pendingWidens(), []);
  state.allowances.set("session-a", 1);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).sessions["session-a"].used, 1, "writing repairs the file");
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no temporary is left behind");
});

test("a newer record written by another bridge wins the merge", () => {
  const { file } = scratch();
  const base = Date.now();
  const mine = createApprovalState({ file, log: quiet, now: () => base });
  mine.allowances.set("session-a", 1);
  // Another bridge spent two allowances on the same session afterwards.
  const theirs = JSON.parse(readFileSync(file, "utf8"));
  theirs.sessions["session-a"] = { used: 3, owned: false, widenedTo: null, updatedAt: base + 1_000 };
  theirs.sessions["session-z"] = { used: 1, owned: false, widenedTo: null, updatedAt: base + 1_000 };
  writeFileSync(file, JSON.stringify(theirs), "utf8");

  mine.owned.set("session-a"); // any write re-reads and merges first
  const merged = createApprovalState({ file, log: quiet });
  assert.equal(merged.allowances.get("session-a"), 3, "the higher count wins; a counter never goes down");
  assert.equal(merged.owned.has("session-a"), true, "the local change still lands");
  assert.equal(merged.allowances.get("session-z"), 1, "the other bridge's session is imported");
});

test("the TTL forgets idle sessions but never an outstanding widen", () => {
  const { file } = scratch();
  const stale = Date.now() - 30 * 24 * 60 * 60_000;
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      sessions: {
        "session-old": { used: 2, owned: true, widenedTo: null, updatedAt: stale },
        "session-wide": { used: 1, owned: true, widenedTo: "read-only", updatedAt: stale },
      },
    }),
    "utf8",
  );
  const state = createApprovalState({ file, log: quiet });
  assert.equal(state.allowances.get("session-old"), undefined, "a month-old allowance is forgotten");
  assert.equal(state.widened.get("session-wide"), "read-only", "an obligation is kept however old");
});

test("prune clears idle counters and keeps obligations", () => {
  const { file } = scratch();
  const stamp = Date.now() - 30 * 24 * 60 * 60_000;
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      sessions: {
        "session-old": { used: 2, owned: true, widenedTo: null, updatedAt: stamp },
        "session-wide": { used: 1, owned: true, widenedTo: "read-only", updatedAt: stamp },
      },
    }),
    "utf8",
  );
  const state = createApprovalState({ file, log: quiet });
  // The load itself already forgets what the TTL says nobody needs.
  assert.equal(state.allowances.get("session-old"), undefined);
  assert.equal(state.owned.has("session-old"), false);
  assert.equal(state.widened.get("session-wide"), "read-only");
  // Any later write must not resurrect it either.
  state.allowances.set("session-new", 1);
  const onDisk = JSON.parse(readFileSync(file, "utf8")).sessions;
  assert.equal(onDisk["session-old"], undefined);
  assert.equal(onDisk["session-wide"].widenedTo, "read-only");
});

test("a gate built on the journal keeps counting after a reload", async () => {
  const { dir } = scratch();
  const file = join(dir, "approvals.json");
  const applied = [];
  const build = () => {
    const state = createApprovalState({ file, log: quiet });
    const store = createPendingStore({ deadlineMs: 5_000, log: quiet });
    const gate = createApprovalGate({
      mode: "delegate",
      isOwned: () => true,
      applyPreset: async (sessionId, name) => {
        applied.push([sessionId, name]);
      },
      currentPreset: () => "workspace-write",
      store,
      state,
      log: quiet,
    });
    return { gate, store, state };
  };
  const run = async (gate, store) => {
    const exec = {
      agent: { session: { id: "session-a" } },
      name: "bash",
      callId: `call-${applied.length}`,
      arguments: { sandbox_permissions: "danger-full-access" },
    };
    const answer = gate.pre(exec, async () => ({ kind: "allow" }));
    for (let i = 0; i < 50 && store.list().length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const [entry] = store.list();
    assert.ok(entry, "the gate asked the caller");
    store.resolve(entry.approvalId, "allow-once");
    const decision = await answer;
    assert.equal(decision.kind, "allow");
    return { decision, exec };
  };

  const first = build();
  const approved = await run(first.gate, first.store);
  // The approved call has to finish, or the journal still says the session is
  // wide and a second escalation would be refused as a ride-along.
  await first.gate.post(approved.exec, { content: [] }, async () => ({ kind: "accept" }));
  assert.equal(first.state.widened.has("session-a"), false, "the approved call put the preset back");
  assert.equal(first.state.allowances.get("session-a"), 1);

  // A reload keeps the same file: the second gate must know one is already spent.
  const second = build();
  assert.equal(second.state.allowances.get("session-a"), 1, "the reloaded gate sees the spent allowance");
  await run(second.gate, second.store);
  assert.equal(createApprovalState({ file, log: quiet }).allowances.get("session-a"), 2);
});

test("recover puts back what an unclean stop left wide", async () => {
  const { file } = scratch();
  const state = createApprovalState({ file, log: quiet });
  state.widened.set("session-b", "read-only");

  const applied = [];
  const gate = createApprovalGate({
    mode: "deny",
    isOwned: () => true,
    onDeny: () => {},
    applyPreset: async (sessionId, name) => {
      applied.push([sessionId, name]);
    },
    state,
    log: quiet,
  });
  const result = await gate.recover();
  assert.deepEqual(applied, [["session-b", "read-only"]]);
  assert.equal(result.restored, 1);
  assert.equal(createApprovalState({ file, log: quiet }).widened.has("session-b"), false, "the debt is settled once");
});

test("persistent allowance reservations refund after rejection and reload", async () => {
  const { file } = scratch();
  const state = createApprovalState({ file, log: quiet });
  const store = createPendingStore({ deadlineMs: 5_000, log: quiet });
  const gate = createApprovalGate({
    mode: "delegate", isOwned: () => true, currentPreset: () => "workspace-write",
    applyPreset: async () => {}, store, state, log: quiet,
  });
  for (let i = 0; i < 3; i += 1) {
    const pending = gate.pre({ agent: { session: { id: "session-refund" } }, name: "bash", callId: `reject-${i}`, arguments: { sandbox_permissions: "danger-full-access" } }, async () => ({ kind: "allow" }));
    for (let j = 0; j < 50 && store.list().length === 0; j += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    store.resolve(store.list()[0].approvalId, "reject");
    assert.equal((await pending).kind, "deny");
    assert.equal(createApprovalState({ file, log: quiet }).allowances.get("session-refund"), undefined);
  }
});

test("reservations merge by identity and retain spent concurrent approvals", () => {
  const { file } = scratch();
  const first = createApprovalState({ file, log: quiet });
  const second = createApprovalState({ file, log: quiet });
  first.reserveAllowance("session-race", "first");
  second.reserveAllowance("session-race", "second");
  first.settleAllowance("session-race", "first", "refunded");
  second.owned.set("session-race", 1);
  const merged = createApprovalState({ file, log: quiet });
  assert.equal(merged.allowances.get("session-race"), 1);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).sessions["session-race"].reservations.first, "refunded");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).sessions["session-race"].reservations.second, "pending");
});

test("a failed startup restore retains its debt and blocks ordinary calls", async () => {
  const { file } = scratch();
  const state = createApprovalState({ file, log: quiet });
  state.widened.set("session-debt", "workspace-write");
  const gate = createApprovalGate({ mode: "deny", isOwned: () => true, applyPreset: async () => { throw new Error("temporary failure"); }, state, log: quiet });
  assert.deepEqual(await gate.recover(), { restored: 0, failed: 1 });
  assert.equal(state.widened.get("session-debt"), "workspace-write");
  assert.equal((await gate.pre({ agent: { session: { id: "session-debt" } }, arguments: {} }, async () => ({ kind: "allow" }))).kind, "deny");
});

test("persistent widened facade can be iterated during dispose", async () => {
  const { file } = scratch();
  const state = createApprovalState({ file, log: quiet });
  state.widened.set("session-dispose", "workspace-write");
  const restored = [];
  const gate = createApprovalGate({ mode: "deny", isOwned: () => true, applyPreset: async (...args) => restored.push(args), state, log: quiet });
  await gate.dispose();
  assert.deepEqual(restored, [["session-dispose", "workspace-write"]]);
});

test("capacity trimming retains all outstanding widen obligations", () => {
  const { file } = scratch();
  const sessions = {};
  sessions["session-obligation"] = { used: 0, owned: true, widenedTo: "read-only", updatedAt: 1, rev: 1 };
  for (let i = 0; i < 2_000; i += 1) sessions[`session-${i}`] = { used: 0, owned: true, widenedTo: null, updatedAt: 100 + i, rev: 1 };
  writeFileSync(file, JSON.stringify({ version: 1, sessions }), "utf8");
  const state = createApprovalState({ file, log: quiet });
  assert.deepEqual(state.pendingWidens(), [{ sessionId: "session-obligation", previous: "read-only" }]);
});

test("a failed restore remains journaled for a later recovery", async () => {
  const { file } = scratch();
  const state = createApprovalState({ file, log: quiet });
  state.widened.set("session-gone", "workspace-write");
  const gate = createApprovalGate({
    mode: "deny",
    isOwned: () => true,
    onDeny: () => {},
    applyPreset: async () => {
      throw new Error("session is not live");
    },
    state,
    log: quiet,
  });
  const result = await gate.recover();
  assert.equal(result.failed, 1);
  assert.equal(state.widened.get("session-gone"), "workspace-write");
});
