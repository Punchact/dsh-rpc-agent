// The approval answerer and the ownership set that scopes it.
//
// These tests are the whole point of extracting both modules: the rule "answer
// only for sessions this bridge created, and only when the operator asked for
// it" has to be checkable without a live Harness, an approval service, or a
// human in the GUI.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-rpc-approvals-"));

import { APPROVAL_MODES, createApprovalResponder } from "../lib/approvals.mjs";
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

const request = (sessionId, extra = {}) => ({
  agent: { session: { id: sessionId } },
  toolName: "bash",
  callId: "call-1",
  reason: "needs 'danger-full-access' for this one command",
  ...extra,
});

const delegateTo = (outcome) => {
  let calls = 0;
  const next = () => {
    calls += 1;
    return Promise.resolve(outcome);
  };
  next.calls = () => calls;
  return next;
};

// ---------------------------------------------------------------- config ----

test("approvals default to off, and an unknown mode is a named config error", () => {
  assert.deepEqual(resolveConfig({}).approvals, { mode: "off" });
  assert.deepEqual(resolveConfig({ approvals: { mode: "deny" } }).approvals, { mode: "deny" });
  // A partial object is legal: `{ mode }` is the only knob today.
  assert.deepEqual(resolveConfig({ approvals: {} }).approvals, { mode: "off" });

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
  assert.deepEqual(resolveConfig({}).approvals, { mode: APPROVAL_MODES[0] });
});

// ------------------------------------------------------------- responder ----

test("mode off installs no listener at all", () => {
  assert.equal(createApprovalResponder({ mode: "off", isOwned: () => true }), null);
  assert.equal(createApprovalResponder({ isOwned: () => true }), null);
});

test("a bridge-owned session is answered with a rejection, not a hang", async () => {
  const denied = [];
  const lines = [];
  const respond = createApprovalResponder({
    mode: "deny",
    isOwned: (id) => id === "session-owned",
    onDeny: (decision) => denied.push(decision),
    log: { info: (line) => lines.push(line) },
  });

  const next = delegateTo("allowed-once");
  const outcome = await respond(request("session-owned"), next);

  assert.equal(outcome, "rejected");
  assert.equal(next.calls(), 0, "claiming the request means the next answerer never runs");
  assert.deepEqual(denied, [{ sessionId: "session-owned", toolName: "bash", callId: "call-1" }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /denied an approval for bash in session-owned/);
});

test("a session this bridge did not create keeps its own answerer", async () => {
  const respond = createApprovalResponder({
    mode: "deny",
    isOwned: (id) => id === "session-owned",
    onDeny: () => assert.fail("must not count a denial it never made"),
  });

  const next = delegateTo("allowed-once");
  assert.equal(await respond(request("session-human"), next), "allowed-once");
  assert.equal(next.calls(), 1);
});

test("an unreadable request is delegated instead of guessed at", async () => {
  const respond = createApprovalResponder({ mode: "deny", isOwned: () => true });
  const next = delegateTo("rejected");
  // No agent, no session id: ownership cannot be established, so the safe
  // direction is silence.
  assert.equal(await respond({ toolName: "bash" }, next), "rejected");
  assert.equal(next.calls(), 1);
});

test("accounting cannot change the answer", async () => {
  const respond = createApprovalResponder({
    mode: "deny",
    isOwned: () => true,
    onDeny: () => {
      throw new Error("counter exploded");
    },
  });
  assert.equal(await respond(request("session-owned"), delegateTo("allowed-once")), "rejected");
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
  assert.deepEqual(stats.snapshot().approvals, { denied: 0 });
  stats.recordApproval("denied");
  stats.recordApproval("denied");
  stats.recordApproval("something-else");
  const snapshot = stats.snapshot();
  assert.deepEqual(snapshot.approvals, { denied: 2 });
  assert.equal(snapshot.total, 0, "an approval is not a call");
});
