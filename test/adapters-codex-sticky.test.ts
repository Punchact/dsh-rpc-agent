// Codex adapter session stickiness (§8.1 / 0.9.5-e).
//
// Two turns from the same agent in the same workspace must continue one app-server
// thread. The fakes here record the exact request sequence, because "did it resume"
// is not visible in the locator alone — a fresh `thread/start` also yields a threadId.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createCodexAdapter } from "../dist/lib/adapters/codex.mjs";
import { createStickySessions } from "../dist/lib/adapters/sticky.mjs";

const fakeBinaryPath = (() => {
  const dir = mkdtempSync(join(tmpdir(), "codex-sticky-"));
  const file = join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  return file;
})();

interface SentMessage {
  method?: string;
  params?: { threadId?: string; cwd?: string; [key: string]: unknown };
}

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(): boolean;
}

function makeFakeSpawn() {
  const sent: SentMessage[] = [];
  let failResume = false;

  const spawn = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: () => child.emit("exit", 0, null),
    }) as FakeChild;

    let buf = "";
    stdin.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as SentMessage & { id?: number | string };
        sent.push(msg);
        if (msg.method === "initialize") {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { platformOs: "windows" } })}\n`);
        } else if (msg.method === "thread/resume") {
          const reply = failResume
            ? { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "thread not found" } }
            : { jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId } } };
          stdout.write(`${JSON.stringify(reply)}\n`);
        } else if (msg.method === "thread/start") {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thr-new" } } })}\n`);
        } else if (msg.method === "turn/start") {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } })}\n`);
        }
      }
    });

    return child;
  };

  return {
    spawn,
    sent,
    setFailResume(value: boolean) {
      failResume = Boolean(value);
    },
  };
}

const request = () => ({
  task: { taskId: "t-sticky", requestSummary: { prompt: "keep going" } },
  workspace: { workspaceId: "ws-1", rootPath: "C:\\repo" },
  agent: { agentId: "agent-1", adapterConfig: {} },
});

function build(fake: ReturnType<typeof makeFakeSpawn>, stickyFile: string) {
  // The fakes satisfy the adapter's duck-typed use; the real signatures demand a full
  // ChildProcess, which would make the test about node's types instead of the adapter.
  return createCodexAdapter({
    spawn: fake.spawn,
    spawnSync: () => ({ status: 0, stdout: "codex-cli 0.166.0-alpha.5.1\n" }),
    binary: fakeBinaryPath,
    sticky: createStickySessions({ file: stickyFile }),
  } as unknown as Parameters<typeof createCodexAdapter>[0]);
}

function tempSticky(): string {
  return join(mkdtempSync(join(tmpdir(), "sticky-store-")), "executor-sessions.json");
}

test("the second turn resumes the thread the first turn created", async () => {
  const stickyFile = tempSticky();

  const firstFake = makeFakeSpawn();
  const first = build(firstFake, stickyFile);
  await first.start(request());
  assert.deepEqual(
    firstFake.sent.map((m) => m.method),
    ["initialize", "initialized", "thread/start", "turn/start"],
    "the first turn has nothing to resume",
  );

  const secondFake = makeFakeSpawn();
  const second = build(secondFake, stickyFile);
  const started = await second.start(request());
  assert.deepEqual(
    secondFake.sent.map((m) => m.method),
    ["initialize", "initialized", "thread/resume", "turn/start"],
    "the second turn continues the remembered thread",
  );
  assert.equal(secondFake.sent[2].params?.threadId, "thr-new");
  assert.equal(started.locator.threadId, "thr-new");
});

test("a thread that cannot be resumed is forgotten and replaced", async () => {
  const stickyFile = tempSticky();
  const store = createStickySessions({ file: stickyFile });
  store.remember({ kind: "codex", agentId: "agent-1", workspaceId: "ws-1" }, "thr-gone");

  const fake = makeFakeSpawn();
  fake.setFailResume(true);
  const started = await build(fake, stickyFile).start(request());

  assert.deepEqual(
    fake.sent.map((m) => m.method),
    ["initialize", "initialized", "thread/resume", "thread/start", "turn/start"],
    "a failed resume falls back to a fresh thread",
  );
  assert.equal(started.locator.threadId, "thr-new");
  assert.equal(
    createStickySessions({ file: stickyFile }).get({ kind: "codex", agentId: "agent-1", workspaceId: "ws-1" }),
    "thr-new",
    "the replacement thread is remembered",
  );
});

test("a request without an agent or workspace never touches the map", async () => {
  const stickyFile = tempSticky();
  const fake = makeFakeSpawn();
  const adapter = build(fake, stickyFile);
  await adapter.start({
    task: { taskId: "t-anon", requestSummary: { prompt: "hi" } },
    workspace: { rootPath: "C:\\repo" },
  });

  assert.deepEqual(
    fake.sent.map((m) => m.method),
    ["initialize", "initialized", "thread/start", "turn/start"],
    "no key, no memory: every anonymous turn starts fresh",
  );
  assert.deepEqual(createStickySessions({ file: stickyFile }).entries(), {});
});
