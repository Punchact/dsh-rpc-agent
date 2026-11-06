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
import test from "node:test";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-rpc-approvals-"));

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
  assert.equal(escalationOf({ sandbox_permissions: 1 }), "", "a number is not a mode");
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
  const decision = await gate(exec("session-owned", { sandbox_permissions: "danger-full-access" }), next);

  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /danger-full-access/);
  assert.match(decision.reason, /has no human to answer an approval prompt/);
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
  assert.deepEqual(await gate(allow("session-owned"), next), { kind: "allow" });
  assert.equal(next.calls(), 1);
});

test("a session this bridge did not create keeps its own answerer", async () => {
  const gate = createApprovalGate({
    mode: "deny",
    isOwned: (id) => id === "session-owned",
    onDeny: () => assert.fail("must not count a denial it never made"),
  });
  const next = delegateTo({ kind: "allow" });
  assert.deepEqual(await gate(exec("session-human", { sandbox_permissions: "danger-full-access" }), next), {
    kind: "allow",
  });
  assert.equal(next.calls(), 1);
});

test("an unreadable call is delegated instead of guessed at", async () => {
  const gate = createApprovalGate({ mode: "deny", isOwned: () => true });
  const next = delegateTo({ kind: "allow" });
  // No agent, no session id: ownership cannot be established, so the safe
  // direction is silence.
  assert.deepEqual(await gate({ name: "bash", arguments: { sandbox_permissions: "danger-full-access" } }, next), {
    kind: "allow",
  });
  assert.equal(next.calls(), 1);
});

test("accounting cannot change the answer", async () => {
  const gate = createApprovalGate({
    mode: "deny",
    isOwned: () => true,
    onDeny: () => {
      throw new Error("counter exploded");
    },
  });
  const decision = await gate(
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
