// Contract tests for the MCP result formatter.
//
// The single rule under test: a tool result is never an error merely because the
// work is unfinished. `status` comes from the Host as a free-form string, so any
// whitelist or `status === "completed"` comparison is a bug — what the caller
// gets instead is `outcome:` plus, when the turn is still going, the one call
// that collects it.

import assert from "node:assert/strict";
import test from "node:test";

import { formatToolError, formatToolResult } from "../lib/mcp-format.mjs";

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
  assert.match(textOf(result), /^收到了/);
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

test("a partial result is treated the same way as a timeout", () => {
  const result = formatToolResult({ sessionId: "s", turn: 1, status: "unknown", text: "", partial: true });
  assert.equal(result.isError, false);
  assert.match(textOf(result), /\(the Harness returned no text\)/);
  assert.match(textOf(result), /do NOT resend the prompt/);
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
