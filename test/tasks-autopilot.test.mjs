import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

import { ACTIVE_STATUSES, createAutopilot } from "../dist/lib/tasks/autopilot.mjs";

function makeEngine(byStatus = {}) {
  const calls = [];
  return {
    calls,
    // The real engine answers from a read transaction, so it is async. Keeping the fake
    // async too is what makes a forgotten `await` fail here instead of on a live host.
    async list(params = {}) {
      calls.push({ ...params });
      const all = byStatus[params.status] ?? [];
      const limit = params.limit ?? 50;
      return { items: all.slice(0, limit), hasMore: all.length > limit, nextCursor: null };
    },
  };
}

function makeDispatcher({ onStart, onPump } = {}) {
  const calls = { start: [], pump: [] };
  return {
    calls,
    async startTask(params) {
      calls.start.push(params);
      if (onStart) return onStart(params);
      return { task: { taskId: params.taskId, status: "running", stateVersion: 3 } };
    },
    async pump(params) {
      calls.pump.push(params);
      if (onPump) return onPump(params);
      return { task: { taskId: params.taskId, status: "running", stateVersion: 4 } };
    },
  };
}

const warningLog = () => {
  const lines = [];
  return { lines, warn: (msg) => lines.push(msg) };
};

test("a pass starts queued tasks and pumps every active status", async () => {
  const engine = makeEngine({
    queued: [{ taskId: "task_q1" }, { taskId: "task_q2" }, { taskId: "task_q3" }],
    dispatching: [{ taskId: "task_d1" }],
    running: [{ taskId: "task_r1" }],
    cancel_requested: [{ taskId: "task_c1" }],
    waiting_input: [{ taskId: "task_w1" }],
    waiting_approval: [{ taskId: "task_w2" }],
  });
  const dispatcher = makeDispatcher();
  const autopilot = createAutopilot({ engine, dispatcher, maxStart: 2, maxPump: 1 });

  const result = await autopilot.step();

  assert.equal(result.skipped, false);
  assert.deepEqual(
    dispatcher.calls.start.map((p) => p.taskId),
    ["task_q1", "task_q2"],
    "only maxStart queued tasks start",
  );
  assert.deepEqual(
    dispatcher.calls.pump.map((p) => p.taskId),
    ["task_d1", "task_r1", "task_c1", "task_w1", "task_w2"],
    "every active status is pumped, in a stable order",
  );
  assert.deepEqual(
    result.pumped.map((p) => p.status),
    ["running", "running", "running", "running", "running"],
  );
  assert.deepEqual(result.failed, []);
  // `queued` and the active statuses were the only queries; a task is never listed twice.
  const queried = engine.calls.map((c) => c.status);
  assert.deepEqual(queried, ["queued", ...ACTIVE_STATUSES]);
});

test("one failing task does not stop the others, and the failure is reported", async () => {
  const engine = makeEngine({
    queued: [{ taskId: "task_bad" }, { taskId: "task_good" }],
    running: [{ taskId: "task_r_bad" }, { taskId: "task_r_good" }],
  });
  const logger = warningLog();
  const dispatcher = makeDispatcher({
    onStart: (params) => {
      if (params.taskId === "task_bad") throw new Error("adapter exploded");
      return { task: { taskId: params.taskId, status: "running", stateVersion: 3 } };
    },
    onPump: (params) => {
      if (params.taskId === "task_r_bad") throw new Error("pump timeout");
      return { task: { taskId: params.taskId, status: "running", stateVersion: 4 } };
    },
  });
  const autopilot = createAutopilot({ engine, dispatcher, logger, maxStart: 5, maxPump: 5 });

  const result = await autopilot.step();

  assert.deepEqual(
    result.started.map((s) => s.taskId),
    ["task_good"],
    "the healthy task still starts",
  );
  assert.deepEqual(
    result.pumped.map((p) => p.taskId),
    ["task_r_good"],
    "the healthy task still pumps",
  );
  assert.deepEqual(
    result.failed.map((f) => f.action),
    ["start", "pump:running"],
  );
  assert.match(result.failed[0].message, /adapter exploded/);
  assert.equal(logger.lines.length, 1);
  assert.match(logger.lines[0], /autopilot pass reported 2 failure\(s\)/);
});

test("a slow pass refuses to stack a second one on top of itself", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const engine = makeEngine({ queued: [{ taskId: "task_q1" }] });
  const dispatcher = makeDispatcher({ onStart: async () => gate });
  const autopilot = createAutopilot({ engine, dispatcher });

  const first = autopilot.step();
  const second = await autopilot.step();
  assert.equal(second.skipped, true);
  assert.deepEqual(second.started, []);
  release({ task: { taskId: "task_q1", status: "running", stateVersion: 3 } });
  const firstResult = await first;
  assert.equal(firstResult.skipped, false);
  assert.equal(dispatcher.calls.start.length, 1, "the queued task started exactly once");
});

test("an empty ledger costs one list per status and drives nothing", async () => {
  const engine = makeEngine({});
  const dispatcher = makeDispatcher();
  const autopilot = createAutopilot({ engine, dispatcher });

  const result = await autopilot.step();

  assert.deepEqual(result.started, []);
  assert.deepEqual(result.pumped, []);
  assert.deepEqual(result.failed, []);
  assert.equal(dispatcher.calls.start.length, 0);
  assert.equal(dispatcher.calls.pump.length, 0);
  assert.equal(engine.calls.length, 1 + ACTIVE_STATUSES.length);
});

test("the bounded pump budget is passed through to the dispatcher", async () => {
  const engine = makeEngine({ running: [{ taskId: "task_r1" }] });
  const dispatcher = makeDispatcher();
  const autopilot = createAutopilot({
    engine,
    dispatcher,
    pumpMaxSteps: 7,
    pumpDeadlineMs: 1_234,
  });

  await autopilot.step();

  assert.deepEqual(dispatcher.calls.pump[0], { taskId: "task_r1", maxSteps: 7, deadlineMs: 1_234 });
});

test("a page answered asynchronously is awaited before dispatch", async () => {
  // Pins the live defect: `engine.list` returns a Promise, and a pass that forgets to
  // await it sees `undefined.items` and silently starts nothing.
  const engine = {
    async list(params) {
      await Promise.resolve();
      return {
        items: params.status === "queued" ? [{ taskId: "task_async" }] : [],
        hasMore: false,
        nextCursor: null,
      };
    },
  };
  const dispatcher = makeDispatcher();
  const autopilot = createAutopilot({ engine, dispatcher });

  const result = await autopilot.step();

  assert.deepEqual(
    dispatcher.calls.start.map((p) => p.taskId),
    ["task_async"],
  );
  assert.deepEqual(result.failed, []);
  assert.equal(result.started[0].taskId, "task_async");
});

test("a broken ledger query is reported, not thrown at the timer", async () => {
  const engine = {
    async list(params) {
      if (params.status === "queued") throw new Error("database is gone");
      return { items: [], hasMore: false, nextCursor: null };
    },
  };
  const dispatcher = makeDispatcher();
  const logger = warningLog();
  const autopilot = createAutopilot({ engine, dispatcher, logger });

  const result = await autopilot.step();

  assert.deepEqual(result.failed.map((f) => f.action), ["list"]);
  assert.match(result.failed[0].message, /database is gone/);
  assert.equal(dispatcher.calls.start.length, 0);
  assert.equal(logger.lines.length, 1);
});

test("AutopilotStepResult rejects missing field at tsc compile time", () => {
  const repoRoot = resolve(import.meta.dirname, "..");
  const configPath = resolve(repoRoot, "tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    repoRoot,
  );
  const virtualFile = resolve(repoRoot, "src/lib/tasks/__typecheck_autopilot__.mts");
  const badSource = `
import type { AutopilotStepResult } from "./autopilot.mjs";
const incomplete: AutopilotStepResult = {
  skipped: false,
  started: [],
  pumped: [],
};
void incomplete;
`;
  const host = ts.createCompilerHost(parsed.options);
  const origGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    if (resolve(fileName) === virtualFile) {
      return ts.createSourceFile(fileName, badSource, languageVersion);
    }
    return origGetSourceFile(fileName, languageVersion, ...rest);
  };
  const program = ts.createProgram([virtualFile], parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(virtualFile));
  assert.ok(diagnostics.length > 0, "tsc must reject incomplete AutopilotStepResult");
  assert.ok(
    diagnostics.some((d) => d.code === 2741 && String(d.messageText).includes("failed")),
    `expected TS2741 mentioning missing failed, got: ${diagnostics.map((d) => `${d.code}:${d.messageText}`).join("; ")}`,
  );
});
