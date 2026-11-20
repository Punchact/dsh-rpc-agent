import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isTaskError } from "../dist/lib/tasks/errors.mjs";
import { createTaskEngine, seedBaselineEntities } from "../dist/lib/tasks/engine.mjs";
import { createDispatcher } from "../dist/lib/tasks/dispatch.mjs";
import { openStore } from "../dist/lib/tasks/store.mjs";

interface ArtifactIndexedPayload {
  artifacts: Array<{ artifactId: string }>;
}

interface ArtifactRefusedPayload {
  refused: Array<{ reason: string; sourcePath?: unknown }>;
}

interface ArtifactEngineView {
  submit(input: Record<string, unknown>): Promise<{ taskId: string }>;
  applyReport(input: Record<string, unknown>): Promise<unknown>;
  events(input: { taskId: string }): Promise<{ events: Array<{ type: string; payload: Record<string, unknown> }> }>;
  readArtifact(input: { taskId: string; artifactId: string; offset: number; length: number }): Promise<{
    encoding: string;
    content: string;
    bytesRead: number;
    truncated: boolean;
    kind: string;
    sha256: string;
  }>;
}

interface ArtifactDispatcherView {
  startTask(input: { taskId: string }): Promise<{ attemptId?: string; attempt?: { attemptId?: string } }>;
}

const seedBaseline = seedBaselineEntities as unknown as (
  store: unknown,
  seed: Record<string, unknown>,
) => Promise<void>;
const buildDispatcher = createDispatcher as unknown as (opts: Record<string, unknown>) => ArtifactDispatcherView;

const SHA = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

async function makeWorld() {
  const store = openStore({ path: ":memory:" });
  await seedBaseline(store, {
    principal: { principalId: "local-operator" },
    workspace: { workspaceId: "ws-lab", rootPath: "C:\\ws-lab" },
    agent: { agentId: "ag-art", adapterKind: "dsh", capabilities: { cancel: "supported" } },
    capabilityRevision: { revisionId: "rev-art-1", capability: "review.diff@1" },
  });
  const engine = createTaskEngine(store) as unknown as ArtifactEngineView;
  const adapter = {
    kind: "dsh",
    async probe() {
      return { ok: true, controls: {} };
    },
    async start() {
      return { locator: { kind: "dsh", sessionId: "sess-art" } };
    },
    async inspect() {
      return { status: "running" };
    },
    async sendInput() {
      return { delivered: true };
    },
    async cancel() {
      return { requestAccepted: true, confirmedStopped: true };
    },
    async events() {
      return { events: [], nextCursor: null };
    },
    async decideApproval() {
      return { delivered: true };
    },
  };
  const dispatcher = buildDispatcher({ store, engine, adapters: { dsh: adapter } });
  return { store, engine, dispatcher };
}

async function startTask(engine: ArtifactEngineView, dispatcher: ArtifactDispatcherView, key: string) {
  const submitted = await engine.submit({
    idempotencyKey: key,
    capabilityRevisionId: "rev-art-1",
    workspaceId: "ws-lab",
    agentId: "ag-art",
    input: { prompt: "review the change" },
  });
  const started = await dispatcher.startTask({ taskId: submitted.taskId });
  return { taskId: submitted.taskId, attemptId: started.attemptId ?? started.attempt?.attemptId ?? null };
}

test("a report indexes verifiable artifacts and readArtifact returns a bounded window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-art-"));
  try {
    const body = Buffer.from("line one\nline two\nline three\n", "utf8");
    const logPath = join(dir, "build.log");
    writeFileSync(logPath, body);

    const { engine, dispatcher } = await makeWorld();
    const { taskId, attemptId } = await startTask(engine, dispatcher, "sub-art-1");

    await engine.applyReport({
      taskId,
      attemptId,
      report: {
        state: "ready",
        summary: "built",
        artifacts: [
          { kind: "log", sourcePath: logPath, sha256: SHA(body), sizeBytes: body.length, name: "build.log" },
        ],
      },
    });

    const events = await engine.events({ taskId });
    const indexed = events.events.find((event) => event.type === "artifact.indexed");
    assert.ok(indexed, "expected artifact.indexed");
    const artifactId = (indexed.payload as unknown as ArtifactIndexedPayload).artifacts[0].artifactId;
    assert.match(artifactId, /^art_[0-9a-f]{24}$/);

    const meta = await engine.readArtifact({ taskId, artifactId, offset: 0, length: 8 });
    assert.equal(meta.encoding, "utf8");
    assert.equal(meta.content, "line one");
    assert.equal(meta.bytesRead, 8);
    assert.equal(meta.truncated, true);
    assert.equal(meta.kind, "log");
    assert.equal(meta.sha256, SHA(body));

    const tail = await engine.readArtifact({ taskId, artifactId, offset: body.length - 6, length: 100 });
    assert.equal(tail.content, "three\n");
    assert.equal(tail.truncated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unverifiable claim is refused, not silently dropped, and non-UTF-8 bytes read back as base64", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-art-"));
  try {
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x41]);
    const binPath = join(dir, "payload.bin");
    writeFileSync(binPath, binary);

    const { engine, dispatcher } = await makeWorld();
    const { taskId, attemptId } = await startTask(engine, dispatcher, "sub-art-2");

    await engine.applyReport({
      taskId,
      attemptId,
      report: {
        state: "ready",
        summary: "built with a bad claim",
        artifacts: [
          { kind: "file", sourcePath: join(dir, "missing.txt"), sha256: SHA(binary), name: "missing.txt" },
          { kind: "log", sourcePath: binPath, sha256: "0".repeat(64), name: "payload.bin" },
        ],
      },
    });

    const events = await engine.events({ taskId });
    const refused = events.events.find((event) => event.type === "artifact.refused");
    assert.ok(refused, "expected artifact.refused");
    const refusedPayload = refused.payload as unknown as ArtifactRefusedPayload;
    assert.equal(refusedPayload.refused.length, 2);
    for (const entry of refusedPayload.refused) {
      assert.equal(typeof entry.reason, "string");
      assert.equal(entry.sourcePath, undefined, "a refusal must not echo the path");
    }

    await engine.applyReport({
      taskId,
      attemptId,
      report: {
        state: "ready",
        summary: "built",
        artifacts: [{ kind: "binary", sourcePath: binPath, sha256: SHA(binary), sizeBytes: binary.length }],
      },
    });
    const after = await engine.events({ taskId });
    const accepted = after.events.filter((event) => event.type === "artifact.indexed").pop()!;
    const artifactId = (accepted.payload as unknown as ArtifactIndexedPayload).artifacts[0].artifactId;

    const read = await engine.readArtifact({ taskId, artifactId, offset: 0, length: 5 });
    assert.equal(read.encoding, "base64");
    assert.equal(read.content, binary.toString("base64"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readArtifact rejects unknown ids and bad windows instead of returning empty bytes", async () => {
  const { engine, dispatcher } = await makeWorld();
  const { taskId } = await startTask(engine, dispatcher, "sub-art-3");

  await assert.rejects(
    () => engine.readArtifact({ taskId, artifactId: "art_missing", offset: 0, length: 10 }),
    (error) => {
      assert.ok(isTaskError(error), "expected a task error");
      return true;
    },
  );

  await assert.rejects(() => engine.readArtifact({ taskId, artifactId: "", offset: 0, length: 10 }), (error) => {
    assert.ok(isTaskError(error), "expected a task error");
    return true;
  });
});
