import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  AGENTS_SUBCOMMANDS,
  CLI_COMMANDS,
  CLI_EXIT_CODE,
  TASKS_SUBCOMMANDS,
  UsageError,
  failureExitCode,
  formatCliError,
  main,
  mixedVersionHint,
  parseArgv,
  probeHealth,
} from "../dist/bin/dsh-rpc.mjs";
const NEXT_HINT =
  "  next: this Harness plugin predates the task centre (0.9.0). Upgrade the plugin inside the DSH profile — the bridge and the plugin ship together.";

function withMockCliRpc(responder, fn) {
  const prevFetch = globalThis.fetch;
  const prevUrl = process.env.DSH_RPC_URL;
  const prevToken = process.env.DSH_RPC_TOKEN;
  const prevWrite = process.stdout.write;
  const prevErrWrite = process.stderr.write;

  process.env.DSH_RPC_URL = "http://127.0.0.1:1/dsh-rpc";
  process.env.DSH_RPC_TOKEN = "cli-test-token-0123456789abcdef";

  let stdout = "";
  let stderr = "";
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };

  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req);
    const ans = await responder(req);
    const payload = ans.error
      ? { jsonrpc: "2.0", id: req.id, error: ans.error }
      : { jsonrpc: "2.0", id: req.id, result: ans.result ?? {} };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(payload);
      },
    };
  };

  return Promise.resolve()
    .then(() => fn({ calls, getStdout: () => stdout, getStderr: () => stderr }))
    .finally(() => {
      globalThis.fetch = prevFetch;
      process.stdout.write = prevWrite;
      process.stderr.write = prevErrWrite;
      if (prevUrl === undefined) delete process.env.DSH_RPC_URL;
      else process.env.DSH_RPC_URL = prevUrl;
      if (prevToken === undefined) delete process.env.DSH_RPC_TOKEN;
      else process.env.DSH_RPC_TOKEN = prevToken;
    });
}

test("parseArgv parses tasks and agents flags cleanly and rejects unknown flags", () => {
  const parsed = parseArgv([
    "tasks",
    "cancel",
    "task_1",
    "--expected-version",
    "2",
    "--reason",
    "stop",
    "--json",
  ]);
  assert.deepEqual(parsed.positional, ["tasks", "cancel", "task_1"]);
  assert.equal(parsed.flags["expected-version"], "2");
  assert.equal(parsed.flags.reason, "stop");
  assert.equal(parsed.flags.json, true);

  assert.throws(() => parseArgv(["tasks", "list", "--bogus-flag"]), UsageError);
});

test("missing or unknown tasks/agents subcommands raise UsageError (exit 2)", async () => {
  await assert.rejects(() => main(["tasks"]), UsageError);
  await assert.rejects(() => main(["tasks", "bogus"]), UsageError);
  await assert.rejects(() => main(["tasks", "get"]), UsageError);
  await assert.rejects(() => main(["tasks", "cancel", "task_1"]), UsageError);
  await assert.rejects(() => main(["tasks", "reconcile", "task_1"]), UsageError);
  await assert.rejects(() => main(["tasks", "resolve", "task_1"]), UsageError, "resolve needs --expected-version");
  await assert.rejects(
    () => main(["tasks", "resolve", "task_1", "--expected-version", "2"]),
    UsageError,
    "resolve needs a decision",
  );
  await assert.rejects(() => main(["agents"]), UsageError);
  await assert.rejects(() => main(["agents", "bogus"]), UsageError);
  await assert.rejects(() => main(["agents", "probe"]), UsageError);
});

test("CLI tasks and agents subcommands invoke matching RPC methods and honor --json", async () => {
  await withMockCliRpc(
    (req) => {
      if (req.method === "dsh.tasks.submit") {
        return {
          result: { taskId: "task_99", status: "queued", phase: "machine/queued", stateVersion: 1 },
        };
      }
      if (req.method === "dsh.tasks.list") {
        return { result: { items: [{ taskId: "task_99", status: "queued", phase: "machine/queued", stateVersion: 1 }], hasMore: false } };
      }
      if (req.method === "dsh.agents.probe") {
        return { result: { agentId: "ag-1", probeStatus: "verified", unknown: [] } };
      }
      return { result: {} };
    },
    async ({ calls, getStdout }) => {
      const c1 = await main(["tasks", "submit", "--workspace", "local", "--agent", "ag-1", "--capability", "cap-1", "hello"]);
      assert.equal(c1, 0);
      assert.equal(calls[0].method, "dsh.tasks.submit");
      assert.match(getStdout(), /task task_99 · queued · machine\/queued/);

      const c2 = await main(["tasks", "list", "--json"]);
      assert.equal(c2, 0);
      assert.equal(calls[1].method, "dsh.tasks.list");

      const c3 = await main(["agents", "probe", "ag-1", "--controls", "start,cancel"]);
      assert.equal(c3, 0);
      assert.equal(calls[2].method, "dsh.agents.probe");
      assert.deepEqual(calls[2].params, { agentId: "ag-1", controls: ["start", "cancel"] });
    },
  );
});

test("mixedVersionHint explains a pre-0.9.0 plugin instead of leaking the RPC error", () => {
  assert.equal(mixedVersionHint("unknown method: dsh.tasks.list"), NEXT_HINT);
  assert.equal(mixedVersionHint("unknown method: dsh.agents.list"), NEXT_HINT);
  assert.equal(mixedVersionHint("unknown method: dsh.sessions.ask"), null);
  assert.equal(mixedVersionHint("boom"), null);
  assert.equal(mixedVersionHint(undefined), null);
  assert.match(NEXT_HINT, /predates the task centre/);
  assert.match(NEXT_HINT, /next:/);
});

test("CLI rejects out-of-range numeric flags, unsafe integers, and malformed JSON before invoking RPC", async () => {
  await withMockCliRpc(
    (req) => {
      if (req.method === "dsh.tasks.dispatch") {
        return {
          result: {
            taskId: "t_fail",
            status: "needs_reconcile",
            stateVersion: 2,
            dispatchFailed: true,
            error: "raw http://127.0.0.1:4035 secret_token",
          },
        };
      }
      return { result: {} };
    },
    async ({ calls, getStdout }) => {
      for (const badArgs of [
        ["tasks", "pump", "t1", "--max-steps", "0"],
        ["tasks", "pump", "t1", "--max-steps", "1001"],
        ["tasks", "pump", "t1", "--max-steps", "1.5"],
        ["tasks", "pump", "t1", "--max-steps", "abc"],
        ["tasks", "list", "--limit", "0"],
        ["tasks", "list", "--limit", "201"],
        ["tasks", "list", "--limit", "2.5"],
        ["tasks", "pump", "t1", "--after-seq", "-1"],
        ["tasks", "pump", "t1", "--after-seq", "9007199254740993"],
        ["tasks", "pump", "t1", "--cursor", "-2"],
        ["tasks", "submit", "--input", "{bad-json"],
        ["call", "dsh.ping", "{bad-json"],
      ]) {
        await assert.rejects(() => main(badArgs), UsageError, `expected UsageError for ${badArgs.join(" ")}`);
      }
      assert.equal(calls.length, 0);

      // Even if a server returns an unsanitized dispatchFailed string, CLI output sanitizes it
      const code = await main(["tasks", "dispatch", "t_fail"]);
      assert.equal(code, 1);
      assert.doesNotMatch(getStdout(), /4035|secret_token/);
    },
  );
});

test("CLI tasks get non-JSON output prints resultValid, degraded, and pending attention/approvals", async () => {
  await withMockCliRpc(
    (req) => {
      if (req.method === "dsh.tasks.get") {
        return {
          result: {
            taskId: "t_unval",
            status: "running",
            phase: "person/review",
            stateVersion: 4,
            degraded: [{ control: "cancel", effect: "cancel moves to needs_reconcile" }],
            pending: {
              attention: [{ questionId: "q_rev", kind: "review", prompt: "check schema" }],
              approvals: [{ approvalId: "ap_1", attemptId: "att_1", summary: "write file" }],
            },
            result: { draft: "ok" },
            resultValid: false,
          },
        };
      }
      return { result: {} };
    },
    async ({ getStdout }) => {
      const code = await main(["tasks", "get", "t_unval"]);
      assert.equal(code, 0);
      const out = getStdout();
      assert.match(out, /task t_unval · running · person\/review · v4/);
      assert.match(out, /degraded \(1\): cancel — cancel moves to needs_reconcile/);
      assert.match(out, /pending attention \(1\): \[review q_rev\] check schema/);
      assert.match(out, /pending approvals \(1\): \[ap_1@att_1\] write file/);
      assert.match(out, /resultValid: false \(unvalidated: failed schema validation\)/);
      assert.match(out, /result: \{"draft":"ok"\} \(unvalidated: failed schema validation\)/);
    },
  );
});

test("CLI probeHealth and failureExitCode distinguish EBADPORT without waiting out --wait or blaming a stopped Harness", async () => {
  assert.equal(failureExitCode({ code: "EBADPORT" }), 3);
  const badPortFmt = formatCliError({
    code: "EBADPORT",
    message: "dsh-rpc dsh.ping: fetch failed (bad port) — fetch refuses this port",
  });
  assert.equal(badPortFmt.exitCode, 3);
  assert.doesNotMatch(badPortFmt.line, /is it running\?/);
  assert.match(badPortFmt.line, /bad port/);

  const refusedFmt = formatCliError({ code: "ECONNREFUSED", message: "refused" });
  assert.equal(refusedFmt.exitCode, 3);
  assert.match(refusedFmt.line, /is it running\?/);

  const prevErrWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };
  const startedAt = Date.now();
  try {
    const exitCode = await probeHealth("http://127.0.0.1:5060/dsh-rpc", 5_000);
    const elapsed = Date.now() - startedAt;
    assert.equal(exitCode, 3);
    assert.ok(elapsed < 1_000, `EBADPORT must fail fast instead of polling --wait, took ${elapsed}ms`);
    assert.match(stderr, /bad port/);
    assert.match(stderr, /--url/);
  } finally {
    process.stderr.write = prevErrWrite;
  }
});
test("the text listing says when a result is unvalidated or a task is degraded", async () => {
  // 0.9.3 复核第三轮：列表是读文字的人第一眼看到的东西，别让他把「看见状态」当成「看见事实」。
  await withMockCliRpc(
    (req) => {
      if (req.method === "dsh.discover") {
        return { result: { config: { tasksEnabled: true }, methods: [{ name: "dsh.tasks.list" }] } };
      }
      if (req.method === "dsh.tasks.list") {
        return {
          result: {
            items: [
              {
                taskId: "task_a",
                status: "review_pending",
                phase: "person/review",
                stateVersion: 4,
                resultValid: false,
                degraded: [{ control: "approval" }],
                pending: { attention: [{ questionId: "q_1" }], approvals: [] },
              },
              { taskId: "task_b", status: "succeeded", phase: "done/Finished", stateVersion: 7, resultValid: true },
            ],
            hasMore: false,
          },
        };
      }
      return { result: {} };
    },
    async ({ getStdout }) => {
      const exitCode = await main(["tasks", "list"]);
      assert.equal(exitCode, 0);
      const out = getStdout();
      assert.match(out, /task task_a · review_pending · person\/review \[unvalidated · degraded\(approval\) · attention=1\]  v4/);
      assert.match(out, /task task_b · succeeded · done\/Finished \[resultValid=true\]  v7/);
    },
  );
});

test("CLI command/subcommand/exit-code tables and formatters reject invalid types at tsc compile time in memory", () => {
  assert.deepEqual(CLI_EXIT_CODE, { ok: 0, failed: 1, usage: 2, connection: 3 });
  assert.equal(CLI_COMMANDS.length, 18);
  assert.equal(TASKS_SUBCOMMANDS.length, 13);
  assert.equal(AGENTS_SUBCOMMANDS.length, 4);

  const repoRoot = resolve(import.meta.dirname, "..");
  const configPath = resolve(repoRoot, "tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    repoRoot,
  );
  const options = { ...parsed.options, noEmit: true, incremental: false, composite: false, declaration: false };
  const validFile = resolve(repoRoot, "src/__cli_valid_probe__.mts");
  const badFile = resolve(repoRoot, "src/__cli_bad_probe__.mts");

  const validSource = `
import {
  CLI_EXIT_CODE,
  type AgentsSubcommand,
  type CliCommand,
  type CliExitCode,
  type CliFlags,
  type TasksSubcommand,
} from "./bin/dsh-rpc.mjs";
import { formatHistory, type FormatHistoryResult, type HistoryPayloadInput } from "./lib/history-format.mjs";
import { normalizeTraceLevel, type TraceLevel } from "./lib/trace-format.mjs";

const cmd: CliCommand = "tasks";
const sub: TasksSubcommand = "dispatch";
const agentSub: AgentsSubcommand = "probe";
const code: CliExitCode = CLI_EXIT_CODE.connection;
const flags: CliFlags = { json: true, trace: "summary" };
const level: TraceLevel = normalizeTraceLevel(flags.trace, "errors");
const histInput: HistoryPayloadInput = { sessionId: "s1", cursor: 1, turn: 1, running: false, records: [] };
const histOut: FormatHistoryResult = formatHistory(histInput, { since: 0 });
void cmd; void sub; void agentSub; void code; void level; void histOut;
`;

  const badSource = `
import {
  type CliCommand,
  type CliExitCode,
  type TasksSubcommand,
} from "./bin/dsh-rpc.mjs";
import type { TraceLevel } from "./lib/trace-format.mjs";

const badCmd: CliCommand = "unknown-command";
const badSub: TasksSubcommand = "destroy";
const badExit: CliExitCode = 99;
const badLevel: TraceLevel = "verbose";
void badCmd; void badSub; void badExit; void badLevel;
`;

  const sources = new Map([
    [validFile, validSource],
    [badFile, badSource],
  ]);
  const host = ts.createCompilerHost(options, true);
  const origGetSourceFile = host.getSourceFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  const origReadFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const resolved = resolve(fileName);
    const virtual = sources.get(resolved);
    if (virtual !== undefined) return ts.createSourceFile(fileName, virtual, languageVersion, true);
    return origGetSourceFile(fileName, languageVersion, onError, shouldCreate);
  };
  host.fileExists = (fileName) => sources.has(resolve(fileName)) || origFileExists(fileName);
  host.readFile = (fileName) => sources.get(resolve(fileName)) ?? origReadFile(fileName);
  host.writeFile = () => {
    throw new Error("the CLI type probe must never write to disk");
  };

  const program = ts.createProgram([validFile, badFile], options, host);
  const collect = (rootFile) => {
    const sf = program.getSourceFile(rootFile);
    if (!sf) throw new Error(`tsc did not load probe ${rootFile}`);
    return ts
      .getPreEmitDiagnostics(program, sf)
      .filter((d) => d.file === sf)
      .map((d) => ({ code: d.code, text: ts.flattenDiagnosticMessageText(d.messageText, " ") }));
  };

  const validDiags = collect(validFile);
  assert.deepEqual(
    validDiags,
    [],
    `valid CLI probe must compile cleanly, got: ${validDiags.map((d) => `TS${d.code}:${d.text}`).join("; ")}`,
  );

  const badDiags = collect(badFile);
  const summary = badDiags.map((d) => `TS${d.code}:${d.text}`).join(" | ");
  assert.ok(badDiags.length >= 4, `expected >= 4 tsc errors, got ${badDiags.length}: ${summary}`);
  assert.ok(badDiags.some((d) => d.text.includes("unknown-command")), `expected unknown-command error: ${summary}`);
  assert.ok(badDiags.some((d) => d.text.includes("destroy")), `expected destroy TasksSubcommand error: ${summary}`);
  assert.ok(badDiags.some((d) => d.text.includes("99")), `expected 99 CliExitCode error: ${summary}`);
  assert.ok(badDiags.some((d) => d.text.includes("verbose")), `expected verbose TraceLevel error: ${summary}`);
});
