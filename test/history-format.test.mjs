// Unit tests for `lib/history-format.mjs`.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_HISTORY_KINDS, formatHistory } from "../dist/lib/history-format.mjs";

test("DEFAULT_HISTORY_KINDS exports the default event allowlist", () => {
  assert.deepEqual(DEFAULT_HISTORY_KINDS, ["tool/call", "tool/result", "turn/end"]);
});

test("header renders running/idle, hasMore, cursor, and optional filter line", () => {
  const base = formatHistory({
    sessionId: "session-1",
    cursor: 42,
    turn: 3,
    running: true,
    messageCount: 12,
    hasMore: true,
    records: [],
  });
  assert.equal(
    base.header,
    "session session-1 · turn 3 · running · window 12 events (hasMore: yes) · cursor 42",
  );

  const idleWithBothFilters = formatHistory(
    {
      sessionId: "session-2",
      cursor: 18,
      turn: 1,
      running: false,
      messageCount: 10,
      hasMore: false,
      records: [{ type: "turn/end", seq: 18, time: 100, data: { reason: { kind: "completed" } } }],
    },
    { since: 5, kinds: ["tool/call", "turn/end"] },
  );
  assert.equal(
    idleWithBothFilters.header,
    [
      "session session-2 · turn 1 · idle · window 10 events (hasMore: no) · cursor 18",
      "filtered: 1 of 10 kept (since 5, kinds tool/call,turn/end)",
    ].join("\n"),
  );

  const sinceOnly = formatHistory(
    { sessionId: "s", cursor: 9, turn: 2, running: false, messageCount: 4, hasMore: false, records: [] },
    { since: 4 },
  );
  assert.equal(
    sinceOnly.header,
    [
      "session s · turn 2 · idle · window 4 events (hasMore: no) · cursor 9",
      "filtered: 0 of 4 kept (since 4)",
    ].join("\n"),
  );

  const wildcardKinds = formatHistory(
    { sessionId: "s", cursor: 9, turn: 2, running: false, messageCount: 4, hasMore: false, records: [] },
    { kinds: "*" },
  );
  assert.equal(
    wildcardKinds.header,
    [
      "session s · turn 2 · idle · window 4 events (hasMore: no) · cursor 9",
      "filtered: 0 of 4 kept (kinds *)",
    ].join("\n"),
  );
});

test("per-type detail rendering, type column padding, callId resolution, and missing seq", () => {
  const payload = {
    sessionId: "session-x",
    cursor: 15,
    turn: 2,
    running: false,
    messageCount: 6,
    hasMore: false,
    records: [
      {
        type: "tool/call",
        seq: 10,
        time: 1000,
        data: { callId: "call-1", name: "pwsh", arguments: { command: "node --version" } },
      },
      {
        type: "tool/result",
        seq: 11,
        time: 1010,
        data: {
          callId: "call-1",
          message: { toolCallId: "call-1", content: [{ type: "text", text: "v24.21.0\nextra line" }] },
        },
      },
      {
        type: "tool/result",
        seq: 12,
        time: 1020,
        data: {
          callId: "missing-call",
          message: { isError: true, content: [{ type: "text", text: "permission denied" }] },
        },
      },
      {
        type: "turn/end",
        seq: 13,
        time: 1030,
        data: { turn: 2, reason: { kind: "completed" } },
      },
      {
        type: "sandbox/mode",
        seq: 14,
        time: 1040,
        data: { mode: "workspace-write" },
      },
      {
        type: "tool/pending",
        data: { callId: "c-p" },
      },
    ],
  };

  const out = formatHistory(payload);
  assert.equal(out.empty, false);
  assert.equal(out.shown, 6);
  assert.equal(out.dropped, 0);
  assert.deepEqual(out.lines, [
    '#10 tool/call    pwsh {"command":"node --version"}',
    '#11 tool/result  pwsh ok "v24.21.0"',
    '#12 tool/result  ? fail "permission denied"',
    '#13 turn/end     reason {"kind":"completed"}',
    '#14 sandbox/mode {"mode":"workspace-write"}',
    '#- tool/pending {"callId":"c-p"}',
  ]);
});

test("detailChars cap and newline collapsing keep each record on a single line", () => {
  const circular = {};
  circular.self = circular;
  circular.toString = () => "first\nsecond\rthird";

  const out = formatHistory(
    {
      sessionId: "s",
      cursor: 3,
      turn: 1,
      running: false,
      messageCount: 3,
      hasMore: false,
      records: [
        {
          type: "tool/call",
          seq: 1,
          data: { name: "pwsh", arguments: { command: "x".repeat(50) } },
        },
        {
          type: "tool/result",
          seq: 2,
          data: {
            name: "read",
            message: { content: [{ type: "text", text: "alpha\rbeta\ngamma" }] },
          },
        },
        {
          type: "custom/raw",
          seq: 3,
          data: circular,
        },
      ],
    },
    { detailChars: 16 },
  );

  assert.equal(out.lines[0], '#1 tool/call    pwsh {"command":"xxx…');
  assert.equal(out.lines[1], '#2 tool/result  read ok "alpha⏎beta"');
  assert.equal(out.lines[2], "#3 custom/raw   first⏎second⏎th…");
  for (const line of out.lines) {
    assert.equal(line.includes("\n"), false);
    assert.equal(line.includes("\r"), false);
  }
});

test("maxLines and maxChars drop excess lines oldest-first and preserve structured.records", () => {
  const records = Array.from({ length: 6 }, (_, i) => ({
    type: "tool/call",
    seq: i + 1,
    time: 1000 + i,
    data: { callId: `c${i + 1}`, name: "read", arguments: { path: `file-${i + 1}.mjs` } },
  }));
  const payload = {
    sessionId: "session-budget",
    cursor: 6,
    turn: 1,
    running: false,
    messageCount: 6,
    hasMore: true,
    records,
    truncated: false,
  };

  // Line budget
  const lineCapped = formatHistory(payload, { maxLines: 4 });
  assert.equal(lineCapped.shown, 3);
  assert.equal(lineCapped.dropped, 3);
  assert.equal(lineCapped.lines.length, 4);
  assert.deepEqual(lineCapped.lines, [
    '#1 tool/call    read {"path":"file-1.mjs"}',
    '#2 tool/call    read {"path":"file-2.mjs"}',
    '#3 tool/call    read {"path":"file-3.mjs"}',
    "… +3 more (raise limit or max_chars)",
  ]);
  // structured.records stays untouched by presentation budgets
  assert.equal(lineCapped.structured.records.length, 6);
  assert.equal(lineCapped.structured.records, records);
  assert.equal(lineCapped.structured.truncated, false);

  // Char budget
  const charCapped = formatHistory(payload, { maxChars: 130 });
  assert.ok(charCapped.lines.join("\n").length <= 130);
  assert.equal(charCapped.lines.at(-1), `… +${charCapped.dropped} more (raise limit or max_chars)`);
  assert.equal(charCapped.shown + charCapped.dropped, 6);
  assert.equal(charCapped.structured.records.length, 6);
});

test("a plugin that ignored since/kinds is reported instead of a fake delta", () => {
  // A 0.7.x plugin answers with the whole window: same shape, no `truncated`,
  // and `seq` values the caller already saw. Printing "filtered: …" there would
  // tell the caller it is looking at a delta when it is looking at everything.
  const unfiltered = {
    sessionId: "session-old",
    cursor: 20,
    turn: 1,
    running: false,
    messageCount: 4,
    hasMore: false,
    records: [
      { type: "tool/call", seq: 17, data: { callId: "c1", name: "pwsh", arguments: { command: "a" } } },
      { type: "tool/result", seq: 18, data: { callId: "c1", message: { content: [{ type: "text", text: "ok" }] } } },
      { type: "turn/start", seq: 19, data: { turn: 1 } },
      { type: "turn/end", seq: 20, data: { reason: { kind: "completed" } } },
    ],
  };

  const out = formatHistory(unfiltered, { since: 18, kinds: ["tool/call", "tool/result", "turn/end"] });
  assert.equal(out.header, "session session-old · turn 1 · idle · window 4 events (hasMore: no) · cursor 20");
  assert.match(out.note, /ignored since and kinds/);
  assert.equal(out.structured.note, out.note);
  // The records are still shown: hiding them would be a lie in the other direction.
  assert.equal(out.shown, 4);

  // Honoured filters produce no note at all.
  const honoured = formatHistory(
    {
      sessionId: "session-new",
      cursor: 20,
      turn: 1,
      running: false,
      messageCount: 2,
      hasMore: false,
      records: [{ type: "tool/call", seq: 19, data: { callId: "c1", name: "pwsh", arguments: { command: "a" } } }],
    },
    { since: 18, kinds: ["tool/call", "tool/result", "turn/end"] },
  );
  assert.equal(honoured.note, null);
  assert.equal("note" in honoured.structured, false);
  assert.match(honoured.header, /filtered: 1 of 2 kept/);
});

test("an ignored max_chars is detected from the payload itself", () => {
  const records = Array.from({ length: 4 }, (_, i) => ({
    type: "tool/call",
    seq: i + 1,
    data: { callId: `c${i + 1}`, name: "pwsh", arguments: { command: "x".repeat(40) } },
  }));
  const payload = {
    sessionId: "s",
    cursor: 4,
    turn: 1,
    running: false,
    messageCount: 4,
    hasMore: false,
    records,
  };

  // Requested 80 chars, got a payload far larger, no `truncated` flag → ignored.
  const ignoredCap = formatHistory(payload, { requestedMaxChars: 80 });
  assert.match(ignoredCap.note, /max_chars/);

  // Same payload with the flag the RPC sets when it did bound the records.
  const bounded = formatHistory({ ...payload, truncated: true }, { requestedMaxChars: 80 });
  assert.equal(bounded.note, null);

  // No request, no accusation.
  assert.equal(formatHistory(payload).note, null);
});

test("empty window sets empty: true, keeps lines empty, and omits absent truncated flag", () => {
  const out = formatHistory({
    sessionId: "session-empty",
    cursor: -1,
    turn: 0,
    running: false,
    messageCount: 0,
    hasMore: false,
    records: [],
  });
  assert.equal(out.empty, true);
  assert.deepEqual(out.lines, []);
  assert.equal(out.shown, 0);
  assert.equal(out.dropped, 0);
  assert.equal("truncated" in out.structured, false);
  assert.deepEqual(out.structured, {
    sessionId: "session-empty",
    cursor: -1,
    turn: 0,
    running: false,
    hasMore: false,
    messageCount: 0,
    records: [],
  });
});
