import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  MAX_EVENT_QUEUE,
  MAX_FRAME_CHARS,
  createCodexAdapter,
  resolveCodexBinary,
} from "../lib/adapters/codex.mjs";
import { TASK_ERROR, isTaskError } from "../lib/tasks/errors.mjs";

function makeFakeSpawn() {
  const sentMessages = [];
  let childRef = null;
  let holdReplies = false;

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
        if (holdReplies) continue;

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
    getChild() {
      return childRef;
    },
    setHoldReplies(v) {
      holdReplies = Boolean(v);
    },
    emitServerLine(obj) {
      childRef.stdout.write(`${JSON.stringify(obj)}\n`);
    },
  };
}

test("resolveCodexBinary skips unreadable WindowsApps and falls back to .codex/.sandbox-bin/codex.exe", () => {
  // Build the expected path with path.join so the assertion holds on every platform:
  // a literal Windows string silently stops matching when CI runs on Linux.
  const sandboxBin = join("C:\\Users\\Tester", ".codex", ".sandbox-bin", "codex.exe");
  const res = resolveCodexBinary({
    homedir: "C:\\Users\\Tester",
    fsOps: {
      readdirSync: () => {
        throw new Error("EACCES");
      },
      existsSync: (p) => p === sandboxBin,
      accessSync: () => {},
    },
  });
  assert.equal(res.source, "sandboxBin");
  assert.equal(res.path, sandboxBin);

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

test("codex adapter ignores req/agent binary overrides and resolveCodexBinary skips 0-byte or non-file candidates", async () => {
  const spawnPaths = [];
  const fake = makeFakeSpawn();
  const wrappedSpawn = (binPath, args, opts) => {
    spawnPaths.push(binPath);
    return fake.spawn(binPath, args, opts);
  };

  const adapter = createCodexAdapter({
    spawn: wrappedSpawn,
    spawnSync: () => ({ status: 0, stdout: "codex-cli 0.166.0\n" }),
    binary: "C:\\trusted\\plugin-codex.exe",
  });

  await adapter.start({
    binary: "C:\\evil\\req-override.exe",
    task: { taskId: "t-sec1", requestSummary: { prompt: "hi" } },
    agent: { adapterConfig: { binary: "C:\\evil\\agent-config.exe" } },
    workspace: { rootPath: "C:\\repo" },
  });
  assert.deepEqual(spawnPaths, ["C:\\trusted\\plugin-codex.exe"]);

  // 0-byte WindowsApps alias + directory must be skipped in favor of real sandbox binary (> 0 bytes)
  const zeroAlias = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0_x64__abc\\app\\resources\\codex.exe";
  const sandboxBin = join("C:\\Users\\Tester", ".codex", ".sandbox-bin", "codex.exe");
  const resolved = resolveCodexBinary({
    homedir: "C:\\Users\\Tester",
    fsOps: {
      readdirSync: () => ["OpenAI.Codex_1.0.0_x64__abc"],
      existsSync: (p) => p === zeroAlias || p === sandboxBin,
      accessSync: () => {},
      statSync: (p) =>
        p === zeroAlias ? { isFile: () => true, size: 0 } : { isFile: () => true, size: 4096 },
    },
  });
  assert.equal(resolved.source, "sandboxBin");
  assert.equal(resolved.path, sandboxBin);

  // Reject directory candidate even when size > 0
  assert.throws(
    () =>
      resolveCodexBinary({
        homedir: "C:\\Users\\Tester",
        fsOps: {
          readdirSync: () => [],
          existsSync: () => true,
          accessSync: () => {},
          statSync: () => ({ isFile: () => false, size: 4096 }),
        },
      }),
    (err) => isTaskError(err, TASK_ERROR.ADAPTER_UNAVAILABLE),
  );
});

test("codex adapter enforces frame limit, non-object filtering, bounded event queue, and stderr drain", async () => {
  const fake = makeFakeSpawn();
  const adapter = createCodexAdapter({
    spawn: fake.spawn,
    spawnSync: () => ({ status: 0, stdout: "codex-cli 0.166.0\n" }),
    binary: "C:\\fake\\codex.exe",
    requestTimeoutMs: 2_000,
  });

  const started = await adapter.start({
    task: { taskId: "t-sec3", requestSummary: { prompt: "hi" } },
    workspace: { rootPath: "C:\\repo" },
  });
  const child = fake.getChild();

  // Non-object JSON frames are ignored cleanly without throwing
  child.stdout.write('"just a string"\n123\n[1,2,3]\nnull\n');
  await new Promise((r) => setTimeout(r, 10));
  const afterNonObj = await adapter.events(started.locator, 0);
  assert.equal(afterNonObj.events.length, 1); // only turn/start

  // Drain stderr bursts without blocking or leaking into events
  for (let i = 0; i < 8; i += 1) {
    const okWrite = child.stderr.write(`diag-${i}: ${"e".repeat(2048)}\n`);
    assert.equal(typeof okWrite, "boolean");
  }
  assert.equal(child.stderr.writableNeedDrain, false);

  // Exceed MAX_EVENT_QUEUE (500): oldest dropped and droppedEvents incremented
  for (let i = 0; i < MAX_EVENT_QUEUE + 4; i += 1) {
    fake.emitServerLine({ method: "item/delta", params: { seq: i } });
  }
  await new Promise((r) => setTimeout(r, 15));
  const bounded = await adapter.events(started.locator, 0);
  assert.equal(bounded.events.length, MAX_EVENT_QUEUE);
  assert.equal(bounded.droppedEvents, 5); // 1 (turn/start) + 504 - 500 = 5
  const nextEmpty = await adapter.events(started.locator, bounded.nextCursor);
  assert.equal(nextEmpty.events.length, 0);

  // Exceed MAX_FRAME_CHARS: triggers protocol_error failed report and rejects pending requests
  fake.setHoldReplies(true);
  const slowReq = adapter.sendInput(started.locator, { text: "wait" });
  child.stdout.write("x".repeat(MAX_FRAME_CHARS + 64));
  await assert.rejects(
    () => slowReq,
    (err) => isTaskError(err, TASK_ERROR.ADAPTER_UNAVAILABLE),
  );
  const afterProto = await adapter.events(started.locator, 0);
  const protoEvt = afterProto.events[afterProto.events.length - 1];
  assert.equal(protoEvt.report.state, "failed");
  assert.equal(protoEvt.report.failureClass, "protocol_error");
  assert.equal(afterProto.protocolError, "frame_exceeds_limit");
});
