// Contract tests for the MCP result formatter.
//
// The single rule under test: a tool result is never an error merely because the
// work is unfinished. `status` comes from the Host as a free-form string, so any
// whitelist or `status === "completed"` comparison is a bug — what the caller
// gets instead is `outcome:` plus, when the turn is still going, the one call
// that collects it.

import assert from "node:assert/strict";
import test from "node:test";

import { describeEnd, formatToolError, formatToolResult } from "../lib/mcp-format.mjs";

const textOf = (result) => result.content.map((part) => part.text).join("\n");

test("a completed turn is plain text, not an error", () => {
  const result = formatToolResult({
    sessionId: "session-1",
    turn: 2,
    status: "completed",
    text: "收到了",
    durationMs: 4200,
    tools: [{ name: "bash" }],
    cursor: 12,
  });
  assert.equal(result.isError, false);
  // The session id leads the result: it is the one thing the caller must be able
  // to keep even when the rest is truncated, because losing it is what produced a
  // new session on every retry.
  assert.match(textOf(result), /^session session-1\n/);
  assert.match(textOf(result), /^session session-1\n收到了/m);
  assert.match(textOf(result), /outcome: completed/);
  assert.match(textOf(result), /cursor 12/);
  assert.doesNotMatch(textOf(result), /next:/);
});

test("an unfinished status is not an error and not whitelisted away", () => {
  // `status` is `reason.kind` verbatim — a Host string this bridge does not own.
  const result = formatToolResult({ sessionId: "session-1", turn: 3, status: "something-new", text: "部分" });
  assert.equal(result.isError, false);
  assert.match(textOf(result), /outcome: something-new/);
});

test("a timed-out turn points at dsh_wait instead of inviting a resend", () => {
  const result = formatToolResult({
    sessionId: "session-1",
    turn: 4,
    status: "timeout",
    text: "已经做了一半",
    timedOut: true,
    cursor: 31,
    durationMs: 600_000,
  });
  assert.equal(result.isError, false);
  const text = textOf(result);
  assert.match(text, /outcome: timeout/);
  assert.match(text, /do NOT resend the prompt/);
  assert.match(text, /dsh_wait\(\{ session_id: "session-1", timeout_ms: 600000, since: 31 \}\)/);
});

test("a partial result does not claim the turn is still running", () => {
  // `partial` is `endEvent === null` — the stream just stopped. The Host may have
  // died with it, so the hint has to cover both possibilities and send the caller
  // to look before it resends anything.
  const result = formatToolResult({ sessionId: "s", turn: 1, status: "unknown", text: "", partial: true });
  assert.equal(result.isError, false);
  const text = textOf(result);
  assert.match(text, /\(the Harness returned no text\)/);
  assert.match(text, /may still be running, or it may have died with the Host/);
  assert.match(text, /check dsh_sessions\(\)/);
  assert.match(text, /do NOT resend the prompt/);
});

test("an aborted turn says who stopped it and forbids a blind resend", () => {
  const user = formatToolResult({
    sessionId: "s",
    turn: 5,
    status: "aborted",
    text: "做了一半就被停了",
    reason: { kind: "aborted", reason: { kind: "user" } },
  });
  assert.equal(user.isError, false);
  const text = textOf(user);
  assert.match(text, /note: the turn was stopped \(cause: user/);
  assert.match(text, /next: do not resend blindly: ask the human/);

  const hook = formatToolResult({
    sessionId: "s",
    turn: 6,
    status: "aborted",
    text: "",
    reason: { kind: "aborted", reason: { kind: "hook", reason: "budget-guard" } },
  });
  assert.match(textOf(hook), /stopped by a hook \(budget-guard\)/);
  assert.match(textOf(hook), /check that hook's rule/);
});

test("blocked, provider errors, truncation and unknown kinds each get their own advice", () => {
  const blocked = formatToolResult({
    sessionId: "s",
    turn: 1,
    status: "blocked",
    text: "",
    reason: { kind: "blocked" },
  });
  assert.match(textOf(blocked), /blocked before it ran/);
  assert.match(textOf(blocked), /do not resend as-is/);

  const failed = formatToolResult({
    sessionId: "s",
    turn: 1,
    status: "error",
    text: "",
    reason: { kind: "error", error: { message: "upstream 529", code: "overloaded" } },
  });
  const failedText = textOf(failed);
  assert.match(failedText, /model\/provider error: overloaded — upstream 529/);
  assert.match(failedText, /this is not a tool failure/);

  const truncated = formatToolResult({
    sessionId: "s",
    turn: 1,
    status: "max-tokens",
    text: "半截",
    reason: { kind: "max-tokens" },
  });
  assert.match(textOf(truncated), /output limit/);
  assert.match(textOf(truncated), /truncates again/);

  // `TurnEndReasonMap` is merge-extensible: a kind this bridge has never seen is
  // normal, and it must degrade to "unverified" instead of silence.
  const stranger = formatToolResult({
    sessionId: "s",
    turn: 1,
    status: "some-new-kind",
    text: "",
    reason: { kind: "some-new-kind" },
  });
  const strangerText = textOf(stranger);
  assert.match(strangerText, /does not know/);
  assert.match(strangerText, /treat this outcome as unverified/);
  assert.equal(stranger.isError, false);
});

test("a timeout reason points at dsh_wait even without the timedOut flag", () => {
  const result = formatToolResult({
    sessionId: "s",
    turn: 7,
    status: "timeout",
    text: "",
    cursor: 9,
    reason: { kind: "timeout", message: "the turn had not finished when the wait budget expired; it keeps running" },
  });
  const text = textOf(result);
  assert.match(text, /note: the turn had not finished/);
  assert.match(text, /dsh_wait\(\{ session_id: "s", timeout_ms: 600000, since: 9 \}\)/);
});

test("describeEnd says nothing about completed", () => {
  assert.equal(describeEnd(null), null);
  assert.equal(describeEnd({ kind: "completed" }), null);
});

test("an accepted non-blocking ask hands back a handle and a next step", () => {
  const result = formatToolResult({
    sessionId: "session-9",
    requestId: "rpc-abc",
    turn: null,
    status: "running",
    text: "",
    accepted: true,
  });
  assert.equal(result.isError, false);
  const text = textOf(result);
  assert.match(text, /accepted: the prompt was submitted/);
  assert.match(text, /outcome: running \(accepted, not waited\)/);
  assert.match(text, /request rpc-abc/);
  assert.match(text, /dsh_wait\(\{ session_id: "session-9", timeout_ms: 600000 \}\)/);
});

test("the sandbox escalation hint is passed through as next", () => {
  const next = { tool: "dsh_ask", args: { session_id: "s", permission: "danger-full-access" } };
  const result = formatToolResult({ sessionId: "s", turn: 1, status: "completed", text: "被拒了", next });
  assert.equal(result.isError, false);
  assert.match(textOf(result), /next: \{"tool":"dsh_ask"/);
  assert.doesNotMatch(textOf(result), /do NOT resend/);
});

test("a failed call is an error and says what to do next", () => {
  const busy = formatToolError("session s is already running a turn", { sessionId: "s" }, -32004);
  assert.equal(busy.isError, true);
  assert.match(textOf(busy), /already running a turn/);
  assert.match(textOf(busy), /next: the session is busy .*dsh_wait\(\{ session_id \}\)/);

  const badArgs = formatToolError("`queue` has no meaning with `wait: false`", undefined, -32602);
  assert.match(textOf(badArgs), /next: fix the arguments/);
  const unknown = formatToolError("boom", undefined, -32099);
  assert.match(textOf(unknown), /next: retry once/);

  const custom = formatToolError("boom", undefined, "call tools/list for the supported names");
  assert.match(textOf(custom), /next: call tools\/list/);
});

test("a handle names the session without inventing a turn number", () => {
  const result = formatToolResult({
    sessionId: "session-h",
    turn: null,
    status: "running",
    accepted: true,
    text: "",
    requestId: "rpc-1",
  });
  const text = textOf(result);
  assert.match(text, /^session session-h/);
  assert.match(text, /outcome: running \(accepted, not waited\)/);
  // A placeholder ("turn ?") looks like data and invites a caller to wait on it.
  assert.doesNotMatch(text, /· turn/);
});

test("a completed turn does not repeat its own outcome as a reason", () => {
  const done = formatToolResult({ sessionId: "s", turn: 1, status: "completed", text: "好", reason: { kind: "completed" } });
  assert.doesNotMatch(textOf(done), /reason:/);

  // Endings that need explaining still carry it.
  const stopped = formatToolResult({ sessionId: "s", turn: 1, status: "aborted", text: "", reason: { kind: "aborted", reason: { kind: "user" } } });
  assert.match(textOf(stopped), /reason: \{"kind":"aborted"/);
});

test("every ending except completed keeps its reason line", () => {
  // Table-driven on purpose: pinning only the two ends (completed / aborted) let a
  // narrowed predicate pass — see the red-team mutation M7, where every other kind
  // was silently swallowed and the suite stayed green.
  const kinds = ["aborted", "blocked", "error", "max-tokens", "interrupted", "forked", "refusal", "unknown", "timeout"];
  for (const kind of kinds) {
    // `status` is deliberately "completed": the line must follow reason.kind, not
    // the Host's free-form status string.
    const out = formatToolResult({ sessionId: "s", turn: 1, status: "completed", text: "x", reason: { kind } });
    assert.match(textOf(out), new RegExp(`reason: \\{"kind":"${kind}"`), `missing reason line for ${kind}`);
  }
  // The one case where the line is pure noise.
  const done = formatToolResult({ sessionId: "s", turn: 1, status: "completed", text: "x", reason: { kind: "completed" } });
  assert.doesNotMatch(textOf(done), /reason:/);
});

test("an error does not dump data the message already carries", () => {
  const busy = formatToolError("session s is already running a turn", { sessionId: "s", next: { tool: "dsh_wait" } }, -32004);
  const text = textOf(busy);
  assert.doesNotMatch(text, /\{"sessionId"/);
  assert.doesNotMatch(text, /"next":/);
  assert.match(text, /next: the session is busy/);
  // Nothing left after dedupe: an empty object is noise, not evidence.
  assert.doesNotMatch(text, /data: \{\}/);

  // Anything the message does not say survives, labelled.
  const invalid = formatToolError("bad value", { field: "mode", value: "nope" }, -32602);
  assert.match(textOf(invalid), /data: \{"field":"mode","value":"nope"\}/);

  // A code with no table hint keeps its own `next`: the summary hint does not
  // replace it, so dropping it would lose the only actionable part.
  const untabled = formatToolError("boom", { next: { tool: "dsh_cancel", args: {} } }, -32099);
  assert.match(textOf(untabled), /"next":\{"tool":"dsh_cancel"/);
});

test("long answers preserve their full body for MCP callers", () => {
  const tail = "TAIL_CANARY_45b70";
  const body = `x`.repeat(2500) + tail;
  const text = textOf(formatToolResult({ sessionId: "s", status: "completed", text: body }));
  assert.ok(text.includes(tail), "the answer tail must be available in the tool result");
  assert.ok(text.includes(body), "the formatter must not silently discard the rest of the answer");
});

test("the wait hint quotes the bridge's configured budget, not a literal", () => {
  const result = { sessionId: "session-a", status: "timeout", timedOut: true, cursor: 5, turn: 1 };
  assert.match(textOf(formatToolResult(result)), /timeout_ms: 600000/);
  assert.match(
    textOf(formatToolResult(result, { defaultTimeoutMs: 45_000 })),
    /timeout_ms: 45000/,
    "a deployment on another default must not be told to ask for 600000",
  );
});

test("a field the message already states is not reprinted as data", () => {
  const text = textOf(
    formatToolError("session session-a is already running turn 7", { sessionId: "session-a", turn: 7 }, -32004),
  );
  assert.doesNotMatch(text, /data: /, "the message already said both values");
});

test("a large tool result preserves its body and trailing metadata", () => {
  const body = "x".repeat(5000);
  const text = textOf(formatToolResult({ sessionId: "session-a", status: "completed", text: body }));
  assert.ok(text.includes(body), "the complete answer must remain available");
  assert.match(text, /outcome: completed/);
});


test("a turn waiting for an approval hands the caller the approval, not a timeout", () => {
  // The whole point of `delegate` is that the caller answers while the turn is
  // stopped on the question. If this rendered as a timeout the caller would be
  // told to wait for something that cannot finish until it answers.
  const result = formatToolResult({
    sessionId: "session-7",
    turn: 3,
    status: "waiting-approval",
    timedOut: false,
    pendingApproval: {
      approvalId: "apv-9d0c",
      sessionId: "session-7",
      toolName: "bash",
      escalation: "danger-full-access",
      argv: "Set-Content -Path C:/Users/Andy/proof.txt -Value probe",
      expiresAt: 1_800_000,
    },
  });
  assert.equal(result.isError, false);
  const text = textOf(result);
  assert.match(text, /^session session-7\n/);
  assert.match(text, /approval: apv-9d0c asks to widen this session to danger-full-access for bash/);
  assert.match(text, /command: Set-Content -Path C:\/Users\/Andy\/proof\.txt/);
  assert.match(text, /next: answer it with dsh_approvals_resolve\(/);
});
