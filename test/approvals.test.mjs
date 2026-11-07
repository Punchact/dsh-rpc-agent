// The escalation gate and the ownership set that scopes it.
//
// These tests are the whole point of extracting both modules: the rule "refuse
// in-place escalation only for sessions this bridge created, and only when the
// operator asked for it" has to be checkable without a live Harness, an approval
// service, or a human in the GUI.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { Context } from "@deepseek-ai/cordis";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-rpc-approvals-"));

// Pending-approval timers are unref'd (a held approval must never keep the Host
// alive), so an awaited expiry has nothing holding the loop open by itself.
const SUITE_KEEPALIVE = setInterval(() => {}, 60_000);
after(() => clearInterval(SUITE_KEEPALIVE));

import { APPROVAL_MODES, createApprovalGate, escalationOf } from "../lib/approvals.mjs";
import { ConfigError, resolveConfig } from "../lib/config.mjs";
import { createMethods } from "../lib/methods.mjs";
import {
  forgetSession,
  isOwnedSession,
  ownSession,
  ownedSessionCount,
  resetOwnedSessions,
} from "../lib/owned.mjs";
import { createStats } from "../lib/stats.mjs";

const exec = (sessionId, args = {}, extra = {}) => ({
  agent: { session: { id: sessionId } },
  name: "bash",
  callId: "call-1",
  arguments: args,
  ...extra,
});

const allow = (sessionId, extra = {}) => exec(sessionId, {}, extra);

const delegateTo = (decision) => {
  let calls = 0;
  const next = () => {
    calls += 1;
    return Promise.resolve(decision);
  };
  next.calls = () => calls;
  return next;
};

// ---------------------------------------------------------------- config ----

test("approvals default to off, and an unknown mode is a named config error", () => {
  assert.deepEqual(resolveConfig({}).approvals, { mode: "off", deadlineMs: 60_000 });
  assert.deepEqual(resolveConfig({ approvals: { mode: "deny" } }).approvals, { mode: "deny", deadlineMs: 60_000 });
  assert.deepEqual(resolveConfig({ approvals: { mode: "delegate", deadlineMs: 5_000 } }).approvals, { mode: "delegate", deadlineMs: 5_000 });
  // A partial object is legal: `{ mode }` is the only knob today.
  assert.deepEqual(resolveConfig({ approvals: {} }).approvals, { mode: "off", deadlineMs: 60_000 });

  assert.throws(
    () => resolveConfig({ approvals: { mode: "allow" } }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /approvals/);
      return true;
    },
    "a typo must fail loudly: silently falling back to off would leave the operator believing denials happen",
  );
  assert.throws(() => resolveConfig({ approvals: "deny" }), ConfigError);
});

test("the described config reports the mode without inventing others", () => {
  assert.deepEqual(resolveConfig({}).approvals, { mode: APPROVAL_MODES[0], deadlineMs: 60_000 });
});

// ------------------------------------------------------------ escalation ----

test("only a string sandbox_permissions counts as an escalation", () => {
  assert.equal(escalationOf({ sandbox_permissions: "danger-full-access" }), "danger-full-access");
  assert.equal(escalationOf({ sandbox_permissions: "  workspace-write  " }), "workspace-write");
  assert.equal(escalationOf({ sandbox_permissions: "" }), "");
  assert.equal(
    escalationOf({ sandbox_permissions: 1 }),
    "non-string:1",
    "a non-string is carried as a refusal, never as a pass",
  );
  assert.equal(escalationOf({}), "");
  assert.equal(escalationOf(undefined), "");
});

// ------------------------------------------------------------------ gate ----

test("mode off installs no gate at all", () => {
  assert.equal(createApprovalGate({ mode: "off", isOwned: () => true }), null);
  assert.equal(createApprovalGate({ isOwned: () => true }), null);
});

test("an escalation from a bridge-owned session is refused before it becomes a prompt", async () => {
  const denied = [];
  const lines = [];
  const gate = createApprovalGate({
    mode: "deny",
    isOwned: (id) => id === "session-owned",
    onDeny: (decision) => denied.push(decision),
    log: { info: (line) => lines.push(line) },
  });

  const next = delegateTo({ kind: "allow" });
  const decision = await gate.pre(exec("session-owned", { sandbox_permissions: "danger-full-access" }), next);

  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /danger-full-access/);
  assert.match(decision.reason, /nobody is attached to this session to approve one/);
  assert.equal(decision.info.name, "DshRpcApprovalDenied");
  assert.equal(decision.info.code, "APPROVAL_DENIED_BY_BRIDGE");
  assert.equal(next.calls(), 0, "refusing the call means the tool body never runs");
  assert.deepEqual(denied, [
    { sessionId: "session-owned", toolName: "bash", callId: "call-1", escalation: "danger-full-access" },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /refused a sandbox escalation to danger-full-access for bash in session-owned/);
});

test("an ordinary call from a bridge-owned session runs untouched", async () => {
  const gate = createApprovalGate({
    mode: "deny",
    isOwned: () => true,
    onDeny: () => assert.fail("nothing was escalated, so nothing may be counted"),
  });
  const next = delegateTo({ kind: "allow" });
  assert.deepEqual(await gate.pre(allow("session-owned"), next), { kind: "allow" });
  assert.equal(next.calls(), 1);
});

test("a session this bridge did not create keeps its own answerer", async () => {
  const gate = createApprovalGate({
    mode: "deny",
    isOwned: (id) => id === "session-owned",
    onDeny: () => assert.fail("must not count a denial it never made"),
  });
  const next = delegateTo({ kind: "allow" });
  assert.deepEqual(await gate.pre(exec("session-human", { sandbox_permissions: "danger-full-access" }), next), {
    kind: "allow",
  });
  assert.equal(next.calls(), 1);
});

test("an unreadable call is delegated instead of guessed at", async () => {
  const gate = createApprovalGate({ mode: "deny", isOwned: () => true });
  const next = delegateTo({ kind: "allow" });
  // No agent, no session id: ownership cannot be established, so the safe
  // direction is silence.
  assert.deepEqual(await gate.pre({ name: "bash", arguments: { sandbox_permissions: "danger-full-access" } }, next), {
    kind: "allow",
  });
  assert.equal(next.calls(), 1);
});

test("real Cordis waterfall does not retry or skip a throwing downstream listener", async () => {
  const ctx = new Context();
  const state = new Map();
  let preset = "workspace-write";
  let answerId;
  const store = {
    open() {
      answerId = "approval";
      let settle;
      const promise = new Promise((resolve) => { settle = resolve; });
      store.resolve = settle;
      return { approvalId: answerId, promise };
    },
  };
  const gate = createApprovalGate({ mode: "delegate", isOwned: () => true, store, state, currentPreset: () => preset, applyPreset: async (_id, value) => { preset = value; } });
  const trace = [];
  ctx.on("probe", gate.pre, { prepend: true });
  ctx.on("probe", async (_exec, next) => { trace.push("throw"); throw new Error("downstream failure"); });
  ctx.on("probe", async (_exec, next) => { trace.push("allow"); return next(); });
  const run = ctx.waterfall(ctx, "probe", exec("session-cordis", { sandbox_permissions: "danger-full-access" }), async () => { trace.push("inner"); return { kind: "allow" }; });
  while (!store.resolve) await new Promise((resolve) => setTimeout(resolve, 0));
  store.resolve({ decision: "allow-once" });
  await assert.rejects(run, /downstream failure/);
  assert.deepEqual(trace, ["throw"]);
  assert.equal(preset, "workspace-write");
});

test("dispose cancels pending approvals and prevents late widening", async () => {
  let settle;
  let preset = "workspace-write";
  const store = { open() { const promise = new Promise((resolve) => { settle = resolve; }); return { approvalId: "pending", promise }; }, cancelAll() { settle?.({ decision: "cancelled" }); } };
  const gate = createApprovalGate({ mode: "delegate", isOwned: () => true, store, currentPreset: () => preset, applyPreset: async (_id, value) => { preset = value; } });
  const pending = gate.pre(exec("session-close", { sandbox_permissions: "danger-full-access" }), async () => ({ kind: "allow" }));
  while (!settle) await new Promise((resolve) => setTimeout(resolve, 0));
  await gate.dispose();
  settle({ decision: "allow-once" });
  assert.equal((await pending).kind, "deny");
  assert.equal(preset, "workspace-write");
  assert.equal((await gate.pre(allow("session-close"), async () => ({ kind: "allow" }))).kind, "deny");
});

test("dispose waits for an approved downstream continuation and denies it after closing", async () => {
  let answer;
  let continueDownstream;
  let continuationStarted = false;
  let preset = "workspace-write";
  const appliedPresets = [];
  const store = {
    open() {
      const promise = new Promise((resolve) => { answer = resolve; });
      return { approvalId: "pending-downstream", promise };
    },
  };
  const gate = createApprovalGate({
    mode: "delegate",
    isOwned: () => true,
    store,
    currentPreset: () => preset,
    applyPreset: async (_id, value) => {
      preset = value;
      appliedPresets.push(value);
    },
  });
  const downstream = new Promise((resolve) => { continueDownstream = resolve; });
  const pending = gate.pre(
    exec("session-dispose-downstream", { sandbox_permissions: "danger-full-access" }),
    () => {
      continuationStarted = true;
      return downstream;
    },
  );
  while (!answer) await new Promise((resolve) => setImmediate(resolve));
  answer({ decision: "allow-once" });
  while (!continuationStarted) await new Promise((resolve) => setImmediate(resolve));

  let disposed = false;
  const disposing = gate.dispose().then(() => { disposed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const disposedBeforeContinuationResolved = disposed;
  continueDownstream({ kind: "allow" });
  const [decision] = await Promise.all([pending, disposing]);

  assert.equal(disposedBeforeContinuationResolved, false, "dispose must wait for the in-flight waterfall continuation");
  assert.equal(decision.kind, "deny", "a closed gate must not return the downstream allow decision");
  assert.equal(preset, "workspace-write");
  assert.deepEqual(appliedPresets, ["danger-full-access", "workspace-write"]);
});

test("dispose waits for an in-flight preset change and restores it before returning", async () => {
  let releasePreset;
  let preset = "workspace-write";
  const store = {
    open() {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      store.answer = resolve;
      return { approvalId: "in-flight", promise };
    },
  };
  const gate = createApprovalGate({
    mode: "delegate",
    isOwned: () => true,
    store,
    currentPreset: () => preset,
    applyPreset: async (_id, value) => {
      if (value === "danger-full-access") await new Promise((resolve) => { releasePreset = resolve; });
      preset = value;
    },
  });
  const pending = gate.pre(exec("session-dispose-race", { sandbox_permissions: "danger-full-access" }), async () => ({ kind: "allow" }));
  while (!store.answer) await new Promise((resolve) => setTimeout(resolve, 0));
  store.answer({ decision: "allow-once" });
  while (!releasePreset) await new Promise((resolve) => setTimeout(resolve, 0));
  const disposed = gate.dispose();
  releasePreset();
  await disposed;
  assert.equal((await pending).kind, "deny");
  assert.equal(preset, "workspace-write");
});

test("accounting cannot change the answer", async () => {
  const gate = createApprovalGate({
    mode: "deny",
    isOwned: () => true,
    onDeny: () => {
      throw new Error("counter exploded");
    },
  });
  const decision = await gate.pre(
    exec("session-owned", { sandbox_permissions: "danger-full-access" }),
    delegateTo({ kind: "allow" }),
  );
  assert.equal(decision.kind, "deny");
});

// ------------------------------------------------------------- ownership ----

test("creation marks ownership; nothing else does", async () => {
  resetOwnedSessions();
  const controller = {
    create: async () => ({ sessionId: "session-created", agentPreset: null }),
    inspect: async () => ({ meta: { cwd: "/tmp/work" } }),
  };
  const methods = createMethods(
    { sessionController: controller, webServer: { getOrigin: () => "http://127.0.0.1:0" } },
    resolveConfig({}),
    { get: () => undefined },
    {},
  );

  assert.equal(isOwnedSession("session-created"), false);
  const created = await methods.createSession({});
  assert.equal(created.sessionId, "session-created");
  assert.equal(isOwnedSession("session-created"), true);
  assert.equal(ownedSessionCount(), 1);

  assert.equal(forgetSession("session-created"), true);
  assert.equal(isOwnedSession("session-created"), false);
  assert.equal(ownSession(""), false, "an empty id is not a session");
});

// ------------------------------------------------------------ accounting ----

test("denials are counted apart from call outcomes", () => {
  const stats = createStats({ startedAt: 0, pid: 1 });
  assert.deepEqual(stats.snapshot().approvals, { denied: 0, allowed: 0 });
  stats.recordApproval("denied");
  stats.recordApproval("denied");
  stats.recordApproval("something-else");
  const snapshot = stats.snapshot();
  assert.deepEqual(snapshot.approvals, { denied: 2, allowed: 0 });
  assert.equal(snapshot.total, 0, "an approval is not a call");
});
