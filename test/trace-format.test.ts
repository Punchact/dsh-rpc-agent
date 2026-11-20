// Unit tests for `lib/trace-format.mjs` and `traceDefault` config resolution.

import assert from "node:assert/strict";
import test from "node:test";

import { describeConfig, resolveConfig } from "../dist/lib/config.mjs";
import {
  TRACE_LEVELS,
  describeTrace,
  isTraceLevel,
  normalizeTraceLevel,
  previewOf,
} from "../dist/lib/trace-format.mjs";

test("level validation and normalization handle case, whitespace and unknown values", () => {
  assert.deepEqual(TRACE_LEVELS, ["none", "errors", "summary", "full"]);
  assert.equal(isTraceLevel("errors"), true);
  assert.equal(isTraceLevel("  FULL  "), true);
  assert.equal(isTraceLevel("Summary"), true);
  assert.equal(isTraceLevel("verbose"), false);
  assert.equal(isTraceLevel(null), false);
  assert.equal(isTraceLevel(undefined), false);

  assert.equal(normalizeTraceLevel("  NONE "), "none");
  assert.equal(normalizeTraceLevel("SuMmArY"), "summary");
  assert.equal(normalizeTraceLevel("bogus"), "errors");
  assert.equal(normalizeTraceLevel(undefined, "full"), "full");
  assert.equal(normalizeTraceLevel(null, "none"), "none");
});

test("previewOf picks command, path, description, JSON, empty and caps at 60 chars", () => {
  assert.equal(previewOf({ command: 'npm   test\n  "all"' }), "npm test 'all'");
  assert.equal(previewOf({ path: "src/app.mjs", description: "ignored" }), "src/app.mjs");
  assert.equal(previewOf({ description: "find   references" }), "find references");
  assert.equal(previewOf({ pattern: "TODO", recursive: true }), "{'pattern':'TODO','recursive':true}");
  // The bridge stores arguments as JSON text, so the preview has to parse them.
  assert.equal(previewOf('{"command":"node --version","description":"Check Node.js version"}'), "node --version");
  assert.equal(previewOf('{"path":"src/app.mjs","offset":10}'), "src/app.mjs");
  assert.equal(previewOf("not json at all"), "not json at all");
  assert.equal(previewOf({}), "");
  assert.equal(previewOf(null), "");
  assert.equal(previewOf(undefined), "");

  const long = previewOf({ command: "x".repeat(80) });
  assert.equal(long.length, 60);
  assert.equal(long.endsWith("…"), true);
});

test("errors level reports counts, up to 3 newest errors, running fallback, or empty", () => {
  const manyErrors = [
    { name: "read", arguments: { path: "a.js" }, ok: true, at: 100, endedAt: 105 },
    { name: "pwsh", arguments: { command: "cmd1" }, ok: false, error: "err one", at: 200, endedAt: 300 },
    { name: "pwsh", arguments: { command: "cmd2" }, isError: true, output: "err two\nline 2", at: 400, endedAt: 500 },
    { name: "pwsh", arguments: { command: "cmd3" }, ok: false, error: { code: 3 }, at: 600, endedAt: 700 },
    { name: "pwsh", arguments: { command: "cmd4" }, ok: false, error: "err four\nmore", at: 800, endedAt: 900 },
  ];
  const res = describeTrace(manyErrors, { level: "errors" });
  assert.equal(res.level, "errors");
  assert.equal(res.total, 5);
  assert.equal(res.errors, 4);
  assert.equal(res.running, 0);
  assert.equal(res.structured, null);
  assert.deepEqual(res.lines, [
    "errors: 4 of 5 tool calls",
    '✗ pwsh "cmd4" — err four',
    '✗ pwsh "cmd3" — {"code":3}',
    '✗ pwsh "cmd2" — err two',
  ]);

  // Running fallback when there are no errors
  const runningTools = [
    { name: "read", arguments: { path: "a.js" }, ok: true, at: 1000, endedAt: 1005 },
    { name: "pwsh", arguments: { command: "sleep 10" }, at: 2000 },
    { name: "pwsh", arguments: { command: "npm test" }, at: 5000 },
  ];
  const runningRes = describeTrace(runningTools, { level: "errors", now: 17200 });
  assert.equal(runningRes.errors, 0);
  assert.equal(runningRes.running, 2);
  assert.deepEqual(runningRes.lines, ['last: pwsh "npm test" (running, 12s)']);

  // A finished turn has no in-flight tool: a missing endedAt is a gap, not a run.
  const finishedRes = describeTrace(runningTools, { level: "errors", now: 17200, status: "completed" });
  assert.deepEqual(finishedRes.lines, []);
  const finishedSummary = describeTrace(runningTools, { level: "summary", now: 17200, status: "completed" });
  assert.ok(finishedSummary.lines.includes('… pwsh "npm test" (unfinished)'));
  assert.equal(finishedSummary.lines.some((line) => line.includes("running,")), false);

  // A tool that produced output but has no end timestamp is "no timing", not "unfinished".
  const oldBridgeTools = [{ name: "pwsh", arguments: '{"command":"node --version"}', output: "v24.21.0", isError: false }];
  const oldBridge = describeTrace(oldBridgeTools, { level: "summary", status: "completed" });
  assert.deepEqual(oldBridge.lines, ['… pwsh "node --version" (no timing)']);

  // Empty when all tools succeeded
  const okTools = [{ name: "read", arguments: { path: "a.js" }, ok: true, at: 100, endedAt: 103 }];
  const okRes = describeTrace(okTools, { level: "errors" });
  assert.deepEqual(okRes.lines, []);
});

test("summary level renders since header, durations, failure details, running state, and overflow trailer", () => {
  const tools = [
    { name: "read", arguments: { path: "src/a.ts" }, ok: true, seq: 2, at: 1000, endedAt: 1003 },
    { name: "pwsh", arguments: { command: "npm test" }, ok: false, error: "exit 1", seq: 4, at: 2000, endedAt: 6210 },
    { name: "pwsh", arguments: { command: "node x" }, seq: 6, at: 10000 },
  ];
  const res = describeTrace(tools, { level: "summary", since: 1, now: 22000 });
  assert.deepEqual(res.since, { cursor: 1, count: 3 });
  assert.deepEqual(res.lines, [
    "+3 since cursor 1",
    '✓ read "src/a.ts" 3ms',
    '✗ pwsh "npm test" 4.2s — exit 1',
    '… pwsh "node x" (running, 12s)',
  ]);

  // Line budget drops lines and appends the overflow trailer within maxLines
  const many = Array.from({ length: 25 }, (_, i) => ({
    name: "read",
    arguments: { path: `f${i}.ts` },
    ok: true,
    at: 1000,
    endedAt: 1002,
  }));
  const capped = describeTrace(many, { level: "summary" });
  assert.equal(capped.truncated.lines, true);
  assert.equal(capped.lines.length, 20);
  assert.equal(capped.lines.at(-1), "… +6 more (call dsh_history for the full window)");
});

test("full level emits blocks with indented output, err line, outputChars cut, and structured payload", () => {
  const tools = [
    {
      callId: "c1",
      name: "read",
      arguments: { path: "a.ts" },
      output: "l1\nl2",
      ok: true,
      seq: 1,
      at: 1000,
      endedAt: 1004,
    },
    {
      callId: "c2",
      name: "pwsh",
      arguments: { command: "npm test" },
      output: "0123456789abcdefghij",
      isError: true,
      error: { code: "EFAIL" },
      ok: false,
      seq: 3,
      at: 2000,
      endedAt: 3500,
    },
    {
      callId: "c3",
      name: "noop",
      arguments: {},
      output: "",
      ok: true,
      seq: 5,
      at: 4000,
      endedAt: 4010,
    },
  ];
  const res = describeTrace(tools, { level: "full", outputChars: 10 });
  assert.equal(res.truncated.lines, false);
  assert.equal(res.truncated.chars, false);
  assert.deepEqual(res.lines, [
    '✓ read "a.ts" 4ms',
    '✗ pwsh "npm test" 1.5s — {"code":"EFAIL"}',
    '✓ noop "" 10ms',
    '▸ read "a.ts" ✓ 4ms',
    "  out: l1\n  l2",
    '▸ pwsh "npm test" ✗ 1.5s',
    "  out: 012345678…",
    '  err: {"code":"…',
    '▸ noop "" ✓ 10ms',
    "  out: (no output)",
  ]);

  assert.equal(Array.isArray(res.structured), true);
  assert.deepEqual(res.structured, [
    {
      index: 0,
      callId: "c1",
      name: "read",
      ok: true,
      arguments: { path: "a.ts" },
      output: "l1\nl2",
      outputTruncated: false,
      isError: false,
      error: null,
      seq: 1,
      at: 1000,
      endedAt: 1004,
      elapsedMs: 4,
    },
    {
      index: 1,
      callId: "c2",
      name: "pwsh",
      ok: false,
      arguments: { command: "npm test" },
      output: "012345678…",
      outputTruncated: true,
      isError: true,
      error: { code: "EFAIL" },
      seq: 3,
      at: 2000,
      endedAt: 3500,
      elapsedMs: 1500,
    },
    {
      index: 2,
      callId: "c3",
      name: "noop",
      ok: true,
      arguments: {},
      output: "",
      outputTruncated: false,
      isError: false,
      error: null,
      seq: 5,
      at: 4000,
      endedAt: 4010,
      elapsedMs: 10,
    },
  ]);

  // Newest blocks win when full budget overflows
  const many = Array.from({ length: 16 }, (_, i) => ({
    callId: `c${i}`,
    name: "pwsh",
    arguments: { command: `cmd-${i}` },
    output: `out-${i}`,
    ok: true,
    seq: i + 1,
    at: 1000,
    endedAt: 1005,
  }));
  const crowded = describeTrace(many, { level: "full", maxLines: 10 });
  assert.equal(crowded.truncated.lines, true);
  assert.ok(crowded.lines.length <= 10);
  const joined = crowded.lines.join("\n");
  assert.match(joined, /▸ pwsh "cmd-15"/);
  assert.doesNotMatch(joined, /▸ pwsh "cmd-0"/);
});

test("budgets enforce maxLines and maxChars across every level and never raise level defaults", () => {
  const heavy = Array.from({ length: 50 }, (_, i) => ({
    callId: `c${i}`,
    name: "pwsh",
    arguments: { command: `long-command-${i}-` + "x".repeat(40) },
    output: "y".repeat(300),
    ok: false,
    error: `failure-${i}-` + "z".repeat(100),
    seq: i + 1,
    at: 1000,
    endedAt: 1050,
  }));

  const expectations: Array<[string, number, number]> = [
    ["none", 0, 0],
    ["errors", 4, 600],
    ["summary", 20, 1200],
    ["full", 40, 8000],
  ];
  for (const [level, defaultLines, defaultChars] of expectations) {
    // Asking for higher limits must never exceed the level default budget
    const res = describeTrace(heavy, { level, maxLines: 999, maxChars: 999_999 });
    assert.ok(res.lines.length <= defaultLines, `${level} exceeded maxLines`);
    assert.ok(res.lines.join("\n").length <= defaultChars, `${level} exceeded maxChars`);

    // Lowering limits explicitly works
    const tightened = describeTrace(heavy, { level, maxLines: 2, maxChars: 80 });
    assert.ok(tightened.lines.length <= Math.min(defaultLines, 2));
    assert.ok(tightened.lines.join("\n").length <= Math.min(defaultChars, 80));
  }
});

test("since filters lines and structured while keeping whole-turn total and errors", () => {
  const tools = [
    { callId: "c1", name: "pwsh", arguments: { command: "fail-old" }, ok: false, error: "boom", seq: 2, at: 10, endedAt: 20 },
    { callId: "c2", name: "read", arguments: { path: "no-seq" }, ok: true, at: 25, endedAt: 30 },
    { callId: "c3", name: "read", arguments: { path: "new.ts" }, ok: true, seq: 6, at: 35, endedAt: 40 },
  ];
  const summaryRes = describeTrace(tools, { level: "summary", since: 4 });
  assert.equal(summaryRes.total, 3);
  assert.equal(summaryRes.errors, 1);
  assert.deepEqual(summaryRes.since, { cursor: 4, count: 1 });
  assert.deepEqual(summaryRes.lines, ["+1 since cursor 4", '✓ read "new.ts" 5ms']);

  const fullRes = describeTrace(tools, { level: "full", since: 4 });
  assert.equal(fullRes.total, 3);
  assert.equal(fullRes.errors, 1);
  const structured = fullRes.structured!;
  assert.equal(structured.length, 1);
  assert.equal(structured[0].callId, "c3");
  assert.equal(structured[0].index, 2);

  // errors level does not re-emit pre-cursor errors when delta has none
  const errRes = describeTrace(tools, { level: "errors", since: 4 });
  assert.equal(errRes.total, 3);
  assert.equal(errRes.errors, 1);
  assert.deepEqual(errRes.lines, []);
});

interface ResolvedTraceConfig {
  traceDefault: string;
  traceDefaultRequested?: string;
}

const resolveTraceConfig = resolveConfig as (input: Record<string, unknown>) => ReturnType<typeof resolveConfig> & ResolvedTraceConfig;

test("config resolves and describes traceDefault with traceDefaultRequested for unknown input", () => {
  const def = resolveTraceConfig({});
  assert.equal(def.traceDefault, "errors");
  assert.equal(def.traceDefaultRequested, undefined);
  assert.equal(describeConfig(def).traceDefault, "errors");
  assert.equal("traceDefaultRequested" in describeConfig(def), false);

  const valid = resolveTraceConfig({ traceDefault: "  SUMMARY " });
  assert.equal(valid.traceDefault, "summary");
  assert.equal(valid.traceDefaultRequested, undefined);
  assert.equal(describeConfig(valid).traceDefault, "summary");

  const invalid = resolveTraceConfig({ traceDefault: "verbose" });
  assert.equal(invalid.traceDefault, "errors");
  assert.equal(invalid.traceDefaultRequested, "verbose");
  assert.equal(describeConfig(invalid).traceDefault, "errors");
  assert.equal(describeConfig(invalid).traceDefaultRequested, "verbose");
});
