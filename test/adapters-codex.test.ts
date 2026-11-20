import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  MAX_EVENT_QUEUE,
  MAX_FRAME_CHARS,
  MAX_PENDING_APPROVALS,
  createCodexAdapter,
  resolveCodexBinary,
} from "../dist/lib/adapters/codex.mjs";
import { TASK_ERROR, isTaskError } from "../dist/lib/tasks/errors.mjs";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// 探针第一步是解析二进制：`resolveCodexBinary` 要求它是普通文件且大小 > 0。CI 跑在 Linux 上，
// 写死 `C:\\fake\\codex.exe` 在那里 stat 不到，探针会先报 binary_not_found 而根本走不到握手。
// 这里造一个跨平台都成立的临时文件，spawn 依旧是假件。
const fakeBinaryPath = (() => {
  const dir = mkdtempSync(join(tmpdir(), "codex-probe-"));
  const file = join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  return file;
})();
interface SentRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: {
    threadId?: string;
    clientInfo?: { name?: string };
    [key: string]: unknown;
  };
}

interface FakeChildProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(): boolean;
}

interface CodexFsOps {
  readdirSync: (p?: string) => string[];
  existsSync: (p: string) => boolean;
  accessSync: (p?: string) => void;
  statSync?: (p: string) => { isFile: () => boolean; size: number };
}

type CodexSpawnFn = (binPath?: string, args?: unknown, opts?: unknown) => FakeChildProcess;
type CodexSpawnSyncFn = () => { status: number; stdout: string };

interface CodexAdapterOptions {
  spawn: CodexSpawnFn;
  spawnSync: CodexSpawnSyncFn;
  binary: string;
  requestTimeoutMs?: number;
  probeTimeoutMs?: number;
  interruptConfirmMs?: number;
  persistThreads?: boolean;
  serviceName?: string;
  threadSource?: string;
}

interface CodexEventRecord {
  report: {
    state: string;
    resultValid?: boolean;
    failureClass?: string;
    observedMethod?: string;
    item: { text?: string };
  };
}

interface CodexAdapterView {
  start(req: Record<string, unknown>): Promise<{
    accepted: boolean;
    locator: { threadId: string; turnId: string; version: string };
  }>;
  sendInput(locator: { threadId: string; turnId: string }, input: { text: string }): Promise<unknown>;
  cancel(locator: { threadId: string; turnId: string }): Promise<unknown>;
  events(
    locator: { threadId: string; turnId: string },
    cursor: number,
  ): Promise<{
    events: CodexEventRecord[];
    nextCursor: number;
    droppedEvents?: number;
    protocolError?: string;
    unknownMethods?: number;
    droppedApprovals?: number;
  }>;
  decideApproval(
    locator: { threadId: string; turnId: string },
    decision: { approvalId: string; decision: string },
  ): Promise<{ accepted: boolean }>;
  probe(): Promise<{
    ok: boolean;
    handshake?: string;
    version?: string;
    reason?: string;
    controls?: { start: boolean; events: boolean; approval: boolean };
  }>;
}

const buildCodexAdapter = createCodexAdapter as unknown as (opts: CodexAdapterOptions) => CodexAdapterView;
const resolveBinary = resolveCodexBinary as unknown as (opts: {
  homedir: string;
  fsOps: CodexFsOps;
}) => { source: string; path: string };

function makeFakeSpawn() {
  const sentMessages: SentRpcMessage[] = [];
  let childRef: FakeChildProcess | null = null;
  let holdReplies = false;

  const spawn: CodexSpawnFn = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: () => child.emit("exit", 0, null),
    }) as FakeChildProcess;
    childRef = child;

    let buf = "";
    stdin.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as SentRpcMessage;
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
      return childRef!;
    },
    setHoldReplies(v: boolean) {
      holdReplies = Boolean(v);
    },
    emitServerLine(obj: Record<string, unknown>) {
      childRef!.stdout.write(`${JSON.stringify(obj)}\n`);
    },
  };
}

test("resolveCodexBinary skips unreadable WindowsApps and falls back to .codex/.sandbox-bin/codex.exe", () => {
  // Build the expected path with path.join so the assertion holds on every platform:
  // a literal Windows string silently stops matching when CI runs on Linux.
  const sandboxBin = join("C:\\Users\\Tester", ".codex", ".sandbox-bin", "codex.exe");
  const res = resolveBinary({
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
      resolveBinary({
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
  const adapter = buildCodexAdapter({
    spawn: fake.spawn,
    spawnSync: () => ({ status: 0, stdout: "codex-cli 0.166.0-alpha.5.1\n" }),
    binary: fakeBinaryPath,
    // No `turn/completed` is emitted in this test, so the cancel must report an
    // unconfirmed stop quickly rather than block the dispatcher.
    interruptConfirmMs: 40,
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
  const cancelled = (await adapter.cancel(started.locator)) as { requestAccepted: boolean; confirmedStopped: boolean };
  assert.equal(cancelled.requestAccepted, true);
  assert.equal(cancelled.confirmedStopped, false, "an acknowledged interrupt is not a confirmed stop");
  assert.equal(fake.sentMessages[4].method, "turn/steer");
  assert.equal(fake.sentMessages[5].method, "turn/interrupt");
  assert.equal(fake.sentMessages[5].params?.threadId, "thr-1");

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

test("codex adapter confirms a cancel only after the server reports the turn as interrupted", async () => {
  const fake = makeFakeSpawn();
  const adapter = buildCodexAdapter({
    spawn: fake.spawn,
    spawnSync: () => ({ status: 0, stdout: "codex-cli 0.169.1\n" }),
    binary: fakeBinaryPath,
    interruptConfirmMs: 2_000,
  });

  const started = await adapter.start({
    task: { taskId: "t-cancel", requestSummary: { prompt: "write 40 bullets" } },
    workspace: { rootPath: "C:\\repo" },
  });

  const pending = adapter.cancel(started.locator) as Promise<{ confirmedStopped: boolean }>;
  // The turn stops a beat later: that notification, not the ack, is the proof.
  setTimeout(() => {
    fake.emitServerLine({
      method: "turn/completed",
      params: { threadId: "thr-1", turn: { id: "turn-1", status: "interrupted" } },
    });
  }, 30);

  const cancelled = await pending;
  assert.equal(cancelled.confirmedStopped, true);
});

test("codex adapter ignores req/agent binary overrides and resolveCodexBinary skips 0-byte or non-file candidates", async () => {
  const spawnPaths: string[] = [];
  const fake = makeFakeSpawn();
  const wrappedSpawn: CodexSpawnFn = (binPath, args, opts) => {
    if (binPath !== undefined) spawnPaths.push(binPath);
    return fake.spawn(binPath, args, opts);
  };

  const adapter = buildCodexAdapter({
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
  const resolved = resolveBinary({
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
      resolveBinary({
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
  const adapter = buildCodexAdapter({
    spawn: fake.spawn,
    spawnSync: () => ({ status: 0, stdout: "codex-cli 0.166.0\n" }),
    binary: fakeBinaryPath,
    requestTimeoutMs: 2_000,
  });

  const started = await adapter.start({
    task: { taskId: "t-sec3", requestSummary: { prompt: "hi" } },
    workspace: { rootPath: "C:\\repo" },
  });
  const child = fake.getChild();

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

test("codex adapter enforces strict frame validation, UTF-8 StringDecoder assembly, and MAX_PENDING_APPROVALS cap", async () => {
  // 1. Strict frame validation cases that must call failProtocol
  const badCases = [
    ["null", "invalid_frame"],
    ["123", "invalid_frame"],
    ["[1,2,3]", "invalid_frame"],
    ['{"jsonrpc":"1.0","method":"turn/started"}', "invalid_frame"],
    ['{"id":{"bad":1},"method":"turn/started"}', "invalid_frame_id"],
    ['{"id":99,"method":"evil/unknownMethod","params":{}}', "unsupported_method"],
    ['{"method":"turn/started","params":"not-an-object"}', "invalid_params"],
  ];

  for (const [badLine, expectedCode] of badCases) {
    const fake = makeFakeSpawn();
    const adapter = buildCodexAdapter({
      spawn: fake.spawn,
      spawnSync: () => ({ status: 0, stdout: "codex-cli 0.166.0\n" }),
      binary: fakeBinaryPath,
    });
    const started = await adapter.start({
      task: { taskId: `t-bad-${expectedCode}`, requestSummary: { prompt: "hi" } },
      workspace: { rootPath: "C:\\repo" },
    });
    fake.getChild().stdout.write(`${badLine}\n`);
    await new Promise((r) => setTimeout(r, 10));
    const ev = await adapter.events(started.locator, 0);
    assert.equal(ev.protocolError, expectedCode, `expected ${expectedCode} for ${badLine}`);
    const last = ev.events[ev.events.length - 1];
    assert.equal(last.report.state, "failed");
    assert.equal(last.report.failureClass, "protocol_error");
  }

  // 2. Unknown notification (no id) is ignored without closing, increments unknownMethods;
  //    split UTF-8 multibyte character across chunks reassembles cleanly;
  //    pendingApprovals > 200 drops oldest and increments droppedApprovals.
  const fake = makeFakeSpawn();
  const adapter = buildCodexAdapter({
    spawn: fake.spawn,
    spawnSync: () => ({ status: 0, stdout: "codex-cli 0.166.0\n" }),
    binary: fakeBinaryPath,
  });
  const started = await adapter.start({
    task: { taskId: "t-utf8-apr", requestSummary: { prompt: "hi" } },
    workspace: { rootPath: "C:\\repo" },
  });
  const child = fake.getChild();

  // Unknown notification without id -> ignored, counter incremented, session stays open
  fake.emitServerLine({ method: "telemetry/heartbeat", params: {} });
  await new Promise((r) => setTimeout(r, 10));

  // Split 3-byte UTF-8 "汉" (E6 B1 89) across two writes
  const prefix = Buffer.from('{"method":"item/agentMessage","params":{"text":"', "utf8");
  const hanBytes = Buffer.from("汉", "utf8"); // 3 bytes
  const suffix = Buffer.from('"}}\n', "utf8");
  child.stdout.write(Buffer.concat([prefix, hanBytes.subarray(0, 1)]));
  child.stdout.write(Buffer.concat([hanBytes.subarray(1), suffix]));
  await new Promise((r) => setTimeout(r, 10));

  const afterUtf8 = await adapter.events(started.locator, 0);
  assert.equal(afterUtf8.unknownMethods, 1);
  assert.equal(afterUtf8.protocolError, undefined);
  const hanEvent = afterUtf8.events.find((e) => e.report.observedMethod === "item/agentMessage")!;
  assert.equal(hanEvent.report.item.text, "汉");

  // Push MAX_PENDING_APPROVALS + 5 approval requests
  for (let i = 1; i <= MAX_PENDING_APPROVALS + 5; i += 1) {
    fake.emitServerLine({
      id: i,
      method: "item/commandExecution/requestApproval",
      params: { command: `echo ${i}` },
    });
  }
  await new Promise((r) => setTimeout(r, 15));

  const afterApr = await adapter.events(started.locator, 0);
  assert.equal(afterApr.droppedApprovals, 5);
  // Oldest 5 (1..5) were dropped; newest 205 (number id) is still pending and reply preserves numeric id
  const stale = await adapter.decideApproval(started.locator, { approvalId: "1", decision: "allow-once" });
  assert.equal(stale.accepted, false);
  const live = await adapter.decideApproval(started.locator, {
    approvalId: String(MAX_PENDING_APPROVALS + 5),
    decision: "allow-once",
  });
  assert.equal(live.accepted, true);
});

test("probe only turns green after the app-server answers initialize", async () => {
  // 0.9.2（复核 NOTES）：以前只看二进制在、--version 能跑就给六项全绿。现在必须真的握手，
  // 且 approval 不给绿——codex 的审批语义我们没在真机验过，能力卡要停在未证实。
  const fake = makeFakeSpawn();
  const adapter = buildCodexAdapter({
    spawn: fake.spawn,
    spawnSync: () => ({ status: 0, stdout: "codex-cli 0.166.0\n" }),
    binary: fakeBinaryPath,
  });

  const res = await adapter.probe();
  assert.equal(res.ok, true);
  assert.equal(res.handshake, "initialize");
  assert.equal(res.version, "codex-cli 0.166.0");
  assert.equal(res.controls!.start, true);
  assert.equal(res.controls!.events, true);
  assert.equal(res.controls!.approval, false, "no live evidence for codex approvals yet");

  const initialized = fake.sentMessages.filter((msg) => msg.method === "initialize");
  assert.equal(initialized.length, 1, "a probe costs exactly one handshake");
  // The service name is what the desktop app writes for its own threads and what makes a
  // bridged session visible there, so the adapter identifies as `codex_work_desktop` by
  // default; `serviceName` overrides it.
  assert.equal(initialized[0].params!.clientInfo!.name, "codex_work_desktop", "handshake identifies as the desktop service");
  assert.equal(
    fake.sentMessages.some((msg) => msg.method === "thread/start" || msg.method === "turn/start"),
    false,
    "a probe must not start work",
  );
});

test("a configured serviceName replaces the desktop default on the wire", async () => {
  const fake = makeFakeSpawn();
  const adapter = buildCodexAdapter({
    spawn: fake.spawn,
    spawnSync: () => ({ status: 0, stdout: "codex-cli 0.169.1\n" }),
    binary: fakeBinaryPath,
    serviceName: "dsh-task-hub",
  });
  const probed = (await adapter.probe()) as { ok?: boolean };
  assert.equal(probed.ok, true);
  const initialized = fake.sentMessages.filter((msg) => msg.method === "initialize");
  assert.equal(initialized[0].params!.clientInfo!.name, "dsh-task-hub");
});

test("probe stays red when the app-server never answers", async () => {
  const fake = makeFakeSpawn();
  fake.setHoldReplies(true);
  const adapter = buildCodexAdapter({
    spawn: fake.spawn,
    spawnSync: () => ({ status: 0, stdout: "codex-cli 0.166.0\n" }),
    binary: fakeBinaryPath,
    probeTimeoutMs: 80,
  });

  const res = await adapter.probe();
  assert.equal(res.ok, false);
  assert.equal(res.reason, "handshake_timeout");
  assert.equal(res.controls, undefined, "a failed handshake must not publish a control table");
});

test("probe reports a spawn failure instead of claiming the executor is ready", async () => {
  const adapter = buildCodexAdapter({
    spawn: () => {
      const error: Error & { code?: string } = new Error("spawn EPERM");
      error.code = "EPERM";
      throw error;
    },
    spawnSync: () => ({ status: 0, stdout: "codex-cli 0.166.0\n" }),
    binary: fakeBinaryPath,
    probeTimeoutMs: 80,
  });

  const res = await adapter.probe();
  assert.equal(res.ok, false);
  assert.equal(res.reason, "EPERM");
});