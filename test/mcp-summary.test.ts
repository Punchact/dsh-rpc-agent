import test from "node:test";
import assert from "node:assert/strict";

import { formatTaskSummary as formatTaskSummaryFromBin } from "../dist/bin/dsh-rpc-mcp.mjs";
import { formatTaskListLine, formatTaskSummary, formatToolError } from "../dist/lib/mcp-format.mjs";

interface SummaryContentPart {
  text: string;
}

interface SummaryToolResult {
  content: SummaryContentPart[];
}

function textOf(result: SummaryToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

assert.equal(formatTaskSummaryFromBin, formatTaskSummary, "bin/dsh-rpc-mcp.mjs re-exports formatTaskSummary");

// 0.9.2 复核（Antigravity，medium）：只读文本的调用方看不到 structuredContent 里的
// `resultValid`。未过校验的结果必须在文字里就带上标记，否则「看得见」会被读成「已经验过」。
test("an unvalidated result says so in the text, not only in structuredContent", () => {
  const result = formatTaskSummary(
    {
      taskId: "task_unvalidated",
      status: "succeeded",
      phase: "done/Finished",
      stateVersion: 6,
      result: { ok: true },
      resultValid: false,
    },
    10_000,
  );

  const text = textOf(result);
  assert.match(text, /result: \{"ok":true\} \(unvalidated: failed schema validation\)/);
  assert.match(text, /unvalidated/, "the meta line repeats the flag so a truncated body cannot hide it");
  assert.equal(result.structuredContent.resultValid, false, "structuredContent still carries the field");
});

test("an unvalidated result that was never stored still shows up as unvalidated", () => {
  const result = formatTaskSummary(
    { taskId: "task_none", status: "waiting_input", phase: "person/answer", stateVersion: 4, result: null, resultValid: false },
    10_000,
  );

  const text = textOf(result);
  assert.match(text, /result: \(none\) \(unvalidated/);
});

test("a validated result is not marked unvalidated", () => {
  const result = formatTaskSummary(
    { taskId: "task_valid", status: "succeeded", phase: "done/Finished", stateVersion: 2, result: { ok: true }, resultValid: true },
    10_000,
  );

  const text = textOf(result);
  assert.doesNotMatch(text, /unvalidated/);
  assert.match(text, /result: \{"ok":true\}/);
});

test("degraded, pending attention, and pending approvals appear in plain text and survive capText truncation", () => {
  const result = formatTaskSummary(
    {
      taskId: "task_wait",
      status: "waiting_input",
      phase: "person/answer",
      stateVersion: 3,
      degraded: [{ control: "cancel", effect: "cancel requests never produce cancelled" }],
      pending: {
        attention: [{ questionId: "q_1", kind: "decision", prompt: "pick target", options: ["a", "b"] }],
        approvals: [{ approvalId: "ap_1", attemptId: "att_1", summary: "run shell" }],
      },
      result: { blob: "x".repeat(400) },
      resultValid: false,
    },
    180,
  );

  const meta = result.content[2].text;
  assert.match(meta, /unvalidated/);
  assert.match(meta, /degraded=1/);
  assert.match(meta, /attention=1/);
  assert.match(meta, /approvals=1/);

  const full = formatTaskSummary(
    {
      taskId: "task_wait",
      status: "waiting_input",
      phase: "person/answer",
      stateVersion: 3,
      degraded: [{ control: "cancel", effect: "cancel requests never produce cancelled" }],
      pending: {
        attention: [{ questionId: "q_1", kind: "decision", prompt: "pick target", options: ["a", "b"] }],
        approvals: [{ approvalId: "ap_1", attemptId: "att_1", summary: "run shell" }],
      },
    },
    10_000,
  );
  const fullText = textOf(full);
  assert.match(fullText, /degraded \(1\): cancel — cancel requests never produce cancelled/);
  assert.match(fullText, /pending attention \(1\): \[decision q_1\] pick target \(options: a \| b\)/);
  assert.match(fullText, /pending approvals \(1\): \[ap_1@att_1\] run shell/);
});

test("preview summary uses preview header instead of task/unknown placeholders and shows degraded", () => {
  const result = formatTaskSummary(
    {
      previewId: "pv_123",
      agentId: "ag-1",
      workspaceId: "local",
      capabilityRevisionId: "cap-1",
      selectionReason: "selected",
      candidates: [
        { agentId: "ag-off", included: false, reason: "AGENT_DISABLED" },
        { agentId: "ag-1", included: true, reason: "SELECTED" },
      ],
      degraded: [{ control: "steer", effect: "no mid-run input" }],
      expiresAt: "2026-11-19T20:00:00.000Z",
    },
    10_000,
  );

  const text = textOf(result);
  assert.match(result.content[0].text, /^preview pv_123 · ag-1 · expires 2026-11-19T20:00:00\.000Z$/);
  assert.doesNotMatch(text, /task \? · unknown/);
  assert.doesNotMatch(text, /\bv\?/);
  assert.match(text, /capability: cap-1/);
  assert.match(text, /candidates \(2\): ag-off\(excluded:AGENT_DISABLED\), ag-1\(selected\)/);
  assert.match(text, /degraded \(1\): steer — no mid-run input/);
  assert.match(result.content[2].text, /preview · degraded=1/);
});

test("formatTaskListLine exposes unvalidated, resultValid=true, degraded, and pending counts", () => {
  assert.equal(
    formatTaskListLine({
      taskId: "t_1",
      status: "succeeded",
      phase: "done/Finished",
      resultValid: false,
      degraded: [{ control: "cancel" }],
      pending: { attention: [{ questionId: "q1" }], approvals: [] },
    }),
    "task t_1 · succeeded · done/Finished [unvalidated · degraded(cancel) · attention=1]",
  );
  assert.equal(
    formatTaskListLine({ taskId: "t_2", status: "succeeded", phase: "done/Finished", resultValid: true }),
    "task t_2 · succeeded · done/Finished [resultValid=true]",
  );
});
test("a passed-through transport code gets a next step instead of being echoed back", () => {
  // 0.9.3 复核第三轮：字符串码会原样透出，若只把码抄一遍，调用方拿到的仍是「去猜」。
  const refused = formatToolError("fetch failed: nothing answered on 127.0.0.1:4035", null, "ECONNREFUSED");
  const refusedText = refused.content[0]?.text ?? "";
  assert.match(refusedText, /next: nothing answered on that port/);
  assert.match(refusedText, /dsh-rpc health/);

  const reset = formatToolError("socket closed", null, "ECONNRESET");
  assert.match(reset.content[0]?.text ?? "", /next: the connection dropped mid-request/);

  // 未知的字符串码仍然直说，不许编一个不存在的下一步。
  const unknown = formatToolError("something odd", null, "EWEIRD");
  assert.match(unknown.content[0]?.text ?? "", /next: EWEIRD/);
});
