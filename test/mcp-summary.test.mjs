import test from "node:test";
import assert from "node:assert/strict";

import { formatTaskSummary } from "../bin/dsh-rpc-mcp.mjs";

function textOf(result) {
  return result.content.map((part) => part.text).join("\n");
}

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
