import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createCodexAdapter, resolveCodexBinary } from "../lib/adapters/codex.mjs";
import { TASK_ERROR, isTaskError } from "../lib/tasks/errors.mjs";

function makeFakeSpawn() {
  const sentMessages = [];
  let childRef = null;

  const spawn = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => child.emit("exit", 0, null);
    childRef = child;

    let buf = "";
    stdin.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        sentMessages.push(msg);

        if (msg.method === "initialize") {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { platformOs: "windows" } })}\n`);
        } else if (msg.method === "thread/start") {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thr-1" } } })}\n`);
        } else if (msg.method === "turn/start") {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } })}\n`);
        } else if (msg.method === "turn/steer") {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { turnId: "turn-1" } })}\n`);
        } else if (msg.method === "turn/interrupt") {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n`);
        }
      }
    });

    return child;
  };

  return {
    spawn,
    sentMessages,
    emitServerLine(obj) {
      childRef.stdout.write(`${JSON.stringify(obj)}\n`);
    },
  };
}

test("resolveCodexBinary skips unreadable WindowsApps and falls back to .codex/.sandbox-bin/codex.exe", () => {
  const res = resolveCodexBinary({
    homedir: "C:\\Users\\Tester",
    fsOps: {
      readdirSync: () => {
        throw new Error("EACCES");
      },
      existsSync: (p) => p === "C:\\Users\\Tester\\.codex\\.sandbox-bin\\codex.exe",
      accessSync: () => {},
    },
  });
  assert.equal(res.source, "sandboxBin");
  assert.equal(res.path, "C:\\Users\\Tester\\.codex\\.sandbox-bin\\codex.exe");

  assert.throws(
    () =>
      resolveCodexBinary({
        homedir: "C:\\Users\\Tester",
        fsOps: {
          readdirSync: () => [],
          existsSync: () => false,
          accessSync: () => {},
        },
      }),
    (err) => isTaskError(err, TASK_ERROR.ADAPTER_UNAVAILABLE),
  );
});

test("codex adapter executes initialize -> initialized -> thread/start -> turn/start, maps turn/completed to ready, and emits turn/interrupt on cancel", async () => {
  const fake = makeFakeSpawn();
  const adapter = createCodexAdapter({
    spawn: fake.spawn,
    spawnSync: () => ({ status: 0, stdout: "codex-cli 0.166.0-alpha.5.1\n" }),
    binary: "C:\\fake\\codex.exe",
  });

  const started = await adapter.start({
    task: { taskId: "t-1", requestSummary: { prompt: "check repo" } },
    workspace: { rootPath: "C:\\repo" },
  });

  assert.equal(started.accepted, true);
  assert.equal(started.locator.threadId, "thr-1");
  assert.equal(started.locator.turnId, "turn-1");
  assert.equal(started.locator.version, "codex-cli 0.166.0-alpha.5.1");

  assert.deepEqual(
    fake.sentMessages.map((m) => m.method),
    ["initialize", "initialized", "thread/start", "turn/start"],
  );

  // Send steer input and cancel
  await adapter.sendInput(started.locator, { text: "keep it concise" });
  await adapter.cancel(started.locator);
  assert.equal(fake.sentMessages[4].method, "turn/steer");
  assert.equal(fake.sentMessages[5].method, "turn/interrupt");
  assert.equal(fake.sentMessages[5].params.threadId, "thr-1");

  // Emit turn/completed notification and drain via events()
  fake.emitServerLine({
    method: "turn/completed",
    params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } },
  });
  await new Promise((r) => setTimeout(r, 10));

  const drained = await adapter.events(started.locator, 0);
  const last = drained.events[drained.events.length - 1];
  assert.equal(last.report.state, "ready");
  assert.equal(last.report.resultValid, true);
});
