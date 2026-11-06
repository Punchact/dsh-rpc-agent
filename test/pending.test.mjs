// Delegated approvals: the store that holds a question, and the gate that asks.
//
// The invariant these tests defend: an escalation is answered by the caller or
// not at all. No answer must never turn into an allow, and "allow" must be the
// only path that widens anything — otherwise the bridge grants permission on a
// timeout, which is the exact failure this feature exists to remove.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-rpc-pending-"));

// The store unrefs its timers on purpose: a pending approval must never keep the
// Host process alive. The consequence is that an awaited expiry has nothing
// holding the event loop open — on Node 22 the run then reports "Promise
// resolution is still pending but the event loop has already resolved". The
// suite keeps one handle for its own duration.
const SUITE_KEEPALIVE = setInterval(() => {}, 60_000);
after(() => clearInterval(SUITE_KEEPALIVE));

import { createApprovalGate } from "../lib/approvals.mjs";
import { resolveConfig } from "../lib/config.mjs";
import { createMethods } from "../lib/methods.mjs";
import { createPendingStore, MAX_PENDING } from "../lib/pending.mjs";

const exec = (sessionId, args = {}) => ({
  agent: { session: { id: sessionId, header: { cwd: "C:/work" } } },
  name: "bash",
  callId: "call-1",
  arguments: args,
});

const escalation = (mode = "danger-full-access") => exec("session-mine", { command: "rm -rf build", sandbox_permissions: mode });

const tick = () => new Promise((r) => setImmediate(r));

test("a pending request can be listed, answered, and is then gone", async () => {
  const store = createPendingStore({ deadlineMs: 5_000 });
  const { approvalId, packet, promise } = store.open({ sessionId: "s1", toolName: "bash" });

  assert.equal(approvalId, "apv-1");
  assert.equal(packet.sessionId, "s1");
  assert.ok(packet.expiresAt > packet.createdAt);
  assert.equal(store.size(), 1);
  assert.deepEqual(
    store.list("s1").map((item) => item.approvalId),
    ["apv-1"],
  );
  assert.deepEqual(store.list("other"), []);

  const outcome = store.resolve(approvalId, "reject", "not this command");
  assert.deepEqual(outcome, { resolved: true, sessionId: "s1", toolName: "bash", decision: "reject" });
  assert.deepEqual(await promise, { decision: "reject", note: "not this command" });
  assert.equal(store.size(), 0);
});

test("an unanswered request expires into a refusal, never an allowance", async () => {
  const store = createPendingStore({ deadlineMs: 20 });
  const { promise } = store.open({ sessionId: "s1", toolName: "bash" });
  const outcome = await promise;
  assert.equal(outcome.decision, "expired");
  assert.equal(store.size(), 0);
});

test("resolving an unknown id reports it instead of inventing a decision", () => {
  const store = createPendingStore({ deadlineMs: 1_000 });
  assert.deepEqual(store.resolve("apv-404", "allow-once"), { resolved: false });
});

test("waitForAny returns as soon as something is pending", async () => {
  const store = createPendingStore({ deadlineMs: 5_000 });
  const waiting = store.waitForAny({ sessionId: "s1", waitMs: 2_000 });
  await tick();
  store.open({ sessionId: "s1", toolName: "bash" });
  const answer = await waiting;
  assert.equal(answer.timedOut, false);
  assert.equal(answer.pending.length, 1);
});

test("waitForAny gives up when the wait expires", async () => {
  const store = createPendingStore({ deadlineMs: 5_000 });
  const answer = await store.waitForAny({ sessionId: "s1", waitMs: 30 });
  assert.equal(answer.timedOut, true);
  assert.deepEqual(answer.pending, []);
});

test("the store keeps a bounded number of pending requests", async () => {
  const store = createPendingStore({ deadlineMs: 50 });
  const opened = [];
  for (let i = 0; i < MAX_PENDING + 3; i += 1) opened.push(store.open({ sessionId: `s${i}`, toolName: "bash" }));
  assert.equal(store.size(), MAX_PENDING);
  // The oldest ones were dropped, which reads as an expiry to whoever holds them.
  assert.equal((await opened[0].promise).decision, "expired");
  assert.equal((await opened.at(-1).promise).decision, "expired");
});

test("delegate without a store or a preset applier degrades to deny", () => {
  const gate = createApprovalGate({ mode: "delegate", isOwned: () => true });
  assert.equal(typeof gate, "function");
  return Promise.resolve(gate(escalation(), () => Promise.resolve({ kind: "allow" }))).then((decision) => {
    assert.equal(decision.kind, "deny");
  });
});

test("an allowed escalation widens the preset and lets the call run", async () => {
  const store = createPendingStore({ deadlineMs: 5_000 });
  const widened = [];
  const allowed = [];
  const gate = createApprovalGate({
    mode: "delegate",
    isOwned: () => true,
    store,
    applyPreset: async (sessionId, name) => {
      widened.push([sessionId, name]);
      return name;
    },
    onAllow: (event) => allowed.push(event),
  });

  let passed = 0;
  const pending = gate(escalation(), () => {
    passed += 1;
    return Promise.resolve({ kind: "allow" });
  });
  await tick();
  assert.equal(store.size(), 1);
  store.resolve(store.list()[0].approvalId, "allow-once");

  const decision = await pending;
  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(passed, 1);
  assert.deepEqual(widened, [["session-mine", "danger-full-access"]]);
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].escalation, "danger-full-access");
});

test("a rejected escalation never reaches the tool", async () => {
  const store = createPendingStore({ deadlineMs: 5_000 });
  const gate = createApprovalGate({ mode: "delegate", isOwned: () => true, store, applyPreset: async () => {} });

  let passed = 0;
  const pending = gate(escalation(), () => {
    passed += 1;
    return Promise.resolve({ kind: "allow" });
  });
  await tick();
  store.resolve(store.list()[0].approvalId, "reject", "too broad");
  const decision = await pending;

  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /The caller answered "reject": too broad/);
  assert.equal(passed, 0);
});

test("an expired escalation is refused with its own reason", async () => {
  const store = createPendingStore({ deadlineMs: 10 });
  const gate = createApprovalGate({ mode: "delegate", isOwned: () => true, store, applyPreset: async () => {} });
  const decision = await gate(escalation(), () => Promise.resolve({ kind: "allow" }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /did not answer within the deadline/);
});

test("an escalation outside the documented ladder is refused without asking", async () => {
  const store = createPendingStore({ deadlineMs: 5_000 });
  const gate = createApprovalGate({ mode: "delegate", isOwned: () => true, store, applyPreset: async () => {} });
  const decision = await gate(escalation("root"), () => Promise.resolve({ kind: "allow" }));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /Only workspace-write and danger-full-access may be requested/);
  assert.equal(store.size(), 0);
});

test("a session stops being asked after its allowance budget is spent", async () => {
  const store = createPendingStore({ deadlineMs: 5_000 });
  const gate = createApprovalGate({ mode: "delegate", isOwned: () => true, store, applyPreset: async () => {} });

  for (let i = 0; i < 3; i += 1) {
    const pending = gate(escalation(), () => Promise.resolve({ kind: "allow" }));
    await tick();
    store.resolve(store.list()[0].approvalId, "allow-once");
    assert.deepEqual(await pending, { kind: "allow" });
  }

  const fourth = await gate(escalation(), () => Promise.resolve({ kind: "allow" }));
  assert.equal(fourth.kind, "deny");
  assert.match(fourth.reason, /already used its 3 delegated escalations/);
  assert.equal(store.size(), 0);
});

test("a session this bridge did not create keeps its own answerer", async () => {
  const store = createPendingStore({ deadlineMs: 5_000 });
  const gate = createApprovalGate({ mode: "delegate", isOwned: () => false, store, applyPreset: async () => {} });
  const decision = await gate(escalation(), () => Promise.resolve({ kind: "allowed-once" }));
  assert.deepEqual(decision, { kind: "allowed-once" });
  assert.equal(store.size(), 0);
});

// The two RPC methods are thin, but they are the part a dispatcher actually
// calls: a wrong shape here would make the whole feature unreachable.

const methodsWith = (store) =>
  createMethods({ sessionController: null, webServer: null, approvals: store }, resolveConfig({}), {}, {});

test("the pending method lists what is waiting and reports the mode", async () => {
  const store = createPendingStore({ deadlineMs: 5_000 });
  store.open({ sessionId: "s1", toolName: "bash", escalation: "danger-full-access", argv: "rm -rf build" });
  const answer = await methodsWith(store).approvalsPending({}, {});
  assert.equal(answer.count, 1);
  assert.equal(answer.pending[0].argv, "rm -rf build");
  assert.equal(answer.mode, "off");
  assert.equal(answer.deadlineMs, 60_000);
});

test("the pending method waits, then reports that nothing arrived", async () => {
  const store = createPendingStore({ deadlineMs: 5_000 });
  const answer = await methodsWith(store).approvalsPending({ waitMs: 30 }, {});
  assert.equal(answer.count, 0);
  assert.equal(answer.timedOut, true);
});

test("resolving answers the request, and an unknown id is a not-found error", async () => {
  const store = createPendingStore({ deadlineMs: 5_000 });
  const methods = methodsWith(store);
  const { approvalId, promise } = store.open({ sessionId: "s1", toolName: "bash" });

  const ok = await methods.approvalsResolve({ approvalId, decision: "allow-once", note: "go" });
  assert.deepEqual(ok, { approvalId, sessionId: "s1", toolName: "bash", decision: "allow-once", note: "go" });
  assert.deepEqual(await promise, { decision: "allow-once", note: "go" });

  await assert.rejects(
    () => methods.approvalsResolve({ approvalId: "apv-404", decision: "reject" }),
    (error) => error.code === -32003,
  );
  await assert.rejects(
    () => methods.approvalsResolve({ approvalId, decision: "maybe" }),
    (error) => error.code === -32602,
  );
});

test("without a store the approval methods say so instead of pretending", async () => {
  const methods = methodsWith(null);
  await assert.rejects(
    () => methods.approvalsPending({}, {}),
    (error) => error.code === -32000 && /approvals.mode/.test(error.message),
  );
});
