import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

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

test("corrupt or unsupported journals are preserved instead of overwritten", () => {
  const { dir, file } = scratch();
  for (const content of ["{ not json", JSON.stringify({ version: 99, sessions: {} })]) {
    writeFileSync(file, content, "utf8");
    assert.throws(() => createApprovalState({ file, log: quiet }), { code: "DSH_RPC_APPROVAL_STATE" });
    assert.equal(readFileSync(file, "utf8"), content);
  }
  writeFileSync(file, JSON.stringify({ version: 1, sessions: {} }));
  const state = createApprovalState({ file, log: quiet });
  writeFileSync(file, "{ broken after startup", "utf8");
  assert.equal(state.reserveAllowance("session-a"), null);
  assert.throws(() => state.owned.set("session-a"), { code: "DSH_RPC_APPROVAL_STATE" });
  assert.equal(readFileSync(file, "utf8"), "{ broken after startup");
  assert.deepEqual(readdirSync(dir), ["approvals.json"], "failed transactions clean up their locks and temporary files");
});

test("a newer record written by another bridge wins the merge", () => {
  const { file } = scratch();
  const base = Date.now();
  const mine = createApprovalState({ file, log: quiet, now: () => base });
  mine.allowances.set("session-a", 1);
  // Another bridge spent two allowances on the same session afterwards.
  const theirs = JSON.parse(readFileSync(file, "utf8"));
  theirs.version = 1; // Simulate an older journal being loaded before migration.
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

test("separate state instances allocate distinct pending tickets without losing either", () => {
  const { file } = scratch();
  const first = createApprovalState({ file, log: quiet });
  const second = createApprovalState({ file, log: quiet });
  const firstTicket = first.reserveAllowance("session-race");
  const secondTicket = second.reserveAllowance("session-race");
  assert.notEqual(firstTicket, secondTicket);
  first.settleAllowance("session-race", firstTicket, "refunded");
  second.owned.set("session-race", 1);
  const merged = createApprovalState({ file, log: quiet });
  assert.equal(merged.allowances.get("session-race"), 1);
  const record = JSON.parse(readFileSync(file, "utf8")).sessions["session-race"];
  assert.equal(record.reservations[firstTicket], undefined, "refunds should leave no ticket behind");
  assert.equal(record.reservations[secondTicket], "pending", "another unresolved approval remains recoverable");
});

test("settled reservation history stays constant-size across repeated refunds", () => {
  const { file } = scratch();
  const state = createApprovalState({ file, log: quiet });
  for (let i = 0; i < 1_000; i += 1) {
    const ticket = state.reserveAllowance("session-refund-growth");
    assert.ok(ticket);
    state.settleAllowance("session-refund-growth", ticket, "refunded");
  }

  const record = JSON.parse(readFileSync(file, "utf8")).sessions["session-refund-growth"];
  assert.deepEqual(record.reservations, {});
  assert.equal(record.sequence, 1_000);
  assert.equal(record.committedUsed, 0);
  assert.equal(state.allowances.get("session-refund-growth"), undefined);
  assert.deepEqual(createApprovalState({ file, log: quiet }).allowances.get("session-refund-growth"), undefined);
});

test("committed reservations fold into a monotonic counter and settle idempotently", () => {
  const { file } = scratch();
  const state = createApprovalState({ file, log: quiet });
  const ticket = state.reserveAllowance("session-commit");
  assert.equal(state.allowances.get("session-commit"), 1);
  state.settleAllowance("session-commit", ticket, "committed");
  state.settleAllowance("session-commit", ticket, "committed");

  let record = JSON.parse(readFileSync(file, "utf8")).sessions["session-commit"];
  assert.equal(record.legacyBase, 0);
  assert.equal(record.committedUsed, 1);
  assert.deepEqual(record.reservations, {});
  assert.equal(state.allowances.get("session-commit"), 1);

  const refund = state.reserveAllowance("session-commit");
  state.settleAllowance("session-commit", refund, "refunded");
  record = JSON.parse(readFileSync(file, "utf8")).sessions["session-commit"];
  assert.equal(record.legacyBase, 0);
  assert.equal(record.committedUsed, 1, "a later rollback must not refund an earlier committed allowance");
  assert.deepEqual(record.reservations, {});
  assert.equal(createApprovalState({ file, log: quiet }).allowances.get("session-commit"), 1);
});

test("legacy reservation states migrate without losing pending recovery or allowance counts", () => {
  const { file } = scratch();
  writeFileSync(file, JSON.stringify({
    version: 1,
    sessions: {
      "session-legacy": {
        used: 3,
        baseUsed: 1,
        owned: true,
        widenedTo: null,
        updatedAt: Date.now(),
        rev: 8,
        reservations: {
          "legacy-committed-a": "committed",
          "legacy-committed-b": "committed",
          "legacy-refunded": "refunded",
          "legacy-pending": "pending",
        },
      },
    },
  }), "utf8");

  const state = createApprovalState({ file, log: quiet });
  assert.equal(state.allowances.get("session-legacy"), 3);
  state.settleAllowance("session-legacy", "legacy-pending", "refunded");
  let record = JSON.parse(readFileSync(file, "utf8")).sessions["session-legacy"];
  assert.equal(record.legacyBase, 2, "legacy usage keeps the greater of base and committed reservations");
  assert.equal(record.legacyCommitted, 0);
  assert.deepEqual(record.legacyPending, {});
  assert.deepEqual(record.reservations, {});
  assert.equal(createApprovalState({ file, log: quiet }).allowances.get("session-legacy"), 2);
  const reloaded = createApprovalState({ file, log: quiet });
  reloaded.settleAllowance("session-legacy", "legacy-pending", "refunded");
  assert.equal(reloaded.allowances.get("session-legacy"), 2, "a repeated refund after reload is idempotent");
});

test("stale instances and old tickets cannot resurrect settled allowances", () => {
  const { file } = scratch();
  const first = createApprovalState({ file, log: quiet });
  const refunded = first.reserveAllowance("session-replay");
  const stale = createApprovalState({ file, log: quiet });
  assert.equal(first.settleAllowance("session-replay", refunded, "refunded"), true);
  for (let i = 0; i < 300; i += 1) {
    const ticket = first.reserveAllowance("session-replay");
    first.settleAllowance("session-replay", ticket, "refunded");
  }
  stale.owned.set("session-replay");
  assert.equal(stale.settleAllowance("session-replay", refunded, "committed"), false);
  assert.equal(stale.settleAllowance("session-replay", "toString", "committed"), false);
  assert.equal(createApprovalState({ file, log: quiet }).allowances.get("session-replay"), undefined);
  const next = stale.reserveAllowance("session-replay");
  assert.notEqual(next, refunded);
  assert.equal(stale.settleAllowance("session-replay", next, "committed"), true);
  assert.equal(first.settleAllowance("session-replay", next, "committed"), false);
  assert.equal(createApprovalState({ file, log: quiet }).allowances.get("session-replay"), 1);
});

test("pending tickets survive TTL and capacity pruning while new commits add to legacy usage", () => {
  const { file } = scratch();
  const stamp = Date.now();
  const state = createApprovalState({ file, log: quiet, now: () => stamp });
  state.allowances.set("session-legacy-floor", 2);
  const ticket = state.reserveAllowance("session-legacy-floor");
  assert.ok(ticket);
  const later = createApprovalState({ file, log: quiet, now: () => stamp + 30 * 24 * 60 * 60_000 });
  later.prune();
  assert.equal(later.allowances.get("session-legacy-floor"), 3);
  assert.equal(later.reserveAllowance("session-legacy-floor"), null);
  assert.equal(later.settleAllowance("session-legacy-floor", ticket, "committed"), true);
  assert.equal(createApprovalState({ file, log: quiet }).allowances.get("session-legacy-floor"), 3);
});

test("concurrent processes allocate at most three unique tickets in one journal", async () => {
  const { dir, file } = scratch();
  const moduleUrl = new URL("../lib/approval-state.mjs", import.meta.url).href;
  const startAt = Date.now() + 500;
  const source = `
    import { writeFileSync } from "node:fs";
    import { createApprovalState } from ${JSON.stringify(moduleUrl)};
    const [file, output, start] = process.argv.slice(1);
    const state = createApprovalState({ file });
    const delay = Math.max(0, Number(start) - Date.now());
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    const ticket = state.reserveAllowance("session-process-race");
    writeFileSync(output, JSON.stringify({ ticket }));
  `;
  await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, file, join(dir, `result-${index}.json`), String(startAt)], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
  })));
  const tickets = Array.from({ length: 8 }, (_, index) => JSON.parse(readFileSync(join(dir, `result-${index}.json`), "utf8")).ticket).filter(Boolean);
  assert.equal(tickets.length, 3);
  assert.equal(new Set(tickets).size, 3);
  const state = createApprovalState({ file, log: quiet });
  assert.equal(state.allowances.get("session-process-race"), 3);
  for (const ticket of tickets) assert.equal(state.settleAllowance("session-process-race", ticket, "refunded"), true);
  assert.equal(createApprovalState({ file, log: quiet }).allowances.get("session-process-race"), undefined);
  assert.equal(readdirSync(dir).some((name) => /\.(lock|stage|released|tmp)$/.test(name)), false);
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

test("journal cleanup failure releases the active approval before dispose", async () => {
  const { file } = scratch();
  const state = createApprovalState({ file, log: quiet });
  const store = createPendingStore({ deadlineMs: 5_000, log: quiet });
  const gate = createApprovalGate({
    mode: "delegate", isOwned: () => true, currentPreset: () => "workspace-write",
    applyPreset: async () => {
      writeFileSync(file, "{ interrupted journal", "utf8");
      throw new Error("preset setter failed");
    },
    store, state, log: quiet,
  });
  let continued = false;
  const answer = gate.pre({ agent: { session: { id: "session-cleanup" } }, name: "bash", callId: "cleanup", arguments: { sandbox_permissions: "danger-full-access" } }, async () => {
    continued = true;
    return { kind: "allow" };
  });
  store.resolve(store.list()[0].approvalId, "allow-once");
  assert.equal((await answer).kind, "deny");
  assert.equal(continued, false);
  let timer;
  try {
    await Promise.race([
      gate.dispose(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("dispose retained an active operation")), 1_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(readFileSync(file, "utf8"), "{ interrupted journal");
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
  sessions["session-pending"] = { used: 1, owned: true, widenedTo: null, updatedAt: 1, rev: 1, reservations: { unresolved: "pending" } };
  for (let i = 0; i < 2_000; i += 1) sessions[`session-${i}`] = { used: 0, owned: true, widenedTo: null, updatedAt: 100 + i, rev: 1 };
  writeFileSync(file, JSON.stringify({ version: 1, sessions }), "utf8");
  const state = createApprovalState({ file, log: quiet });
  assert.deepEqual(state.pendingWidens(), [{ sessionId: "session-obligation", previous: "read-only" }]);
  assert.equal(state.allowances.get("session-pending"), 1);
  assert.equal(state.settleAllowance("session-pending", "unresolved", "refunded"), true);
  assert.equal(state.allowances.get("session-pending"), undefined);
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
