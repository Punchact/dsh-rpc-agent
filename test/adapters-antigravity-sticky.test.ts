// Antigravity adapter session stickiness (§8.1 / 0.9.5-e).
//
// A cascade is the Antigravity-side conversation. Reusing the id keeps the executor's
// context between turns; the assertion is on the request body, because a fresh uuid
// and a remembered id are indistinguishable from the locator alone.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAntigravityAdapter } from "../dist/lib/adapters/antigravity.mjs";
import { createStickySessions } from "../dist/lib/adapters/sticky.mjs";

interface FakeCall {
  method: string;
  body: Record<string, unknown>;
}

function makeFakeFetch() {
  const calls: FakeCall[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const method = url.split("/").pop() ?? "";
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    const replies: Record<string, unknown> = {
      GetCascadeModelConfigData: {
        clientModelConfigs: [{ modelId: "gemini-4-hydrogen-high", modelOrAlias: { model: "MODEL_PLACEHOLDER_M777" } }],
      },
      StartCascade: { cascadeId: body.cascadeId },
      SendUserCascadeMessage: {},
    };
    const reply = replies[method] ?? {};
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(reply);
      },
    };
  };
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

function daemonDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ag-sticky-"));
  writeFileSync(
    join(dir, "hub_4035.json"),
    JSON.stringify({ pid: process.pid, httpPort: 4035, httpsPort: 4034, lsVersion: "2.32.2", csrfToken: "csrf-test" }),
  );
  return dir;
}

const request = () => ({
  task: {
    taskId: "t-ag-sticky",
    requestSummary: { projectId: "proj-abc", model: "gemini-4-hydrogen-high", prompt: "keep going" },
  },
  workspace: { workspaceId: "ws-ag", rootPath: "C:\\Users\\Andy\\Documents\\Google Antigravity" },
  agent: { agentId: "agent-ag", adapterConfig: {} },
});

test("the second turn continues the cascade the first turn started", async () => {
  const dir = daemonDir();
  const stickyFile = join(dir, "executor-sessions.json");
  const sticky = createStickySessions({ file: stickyFile });

  const firstFake = makeFakeFetch();
  const first = createAntigravityAdapter({ fetch: firstFake.fetch, daemonDir: dir, isPidAlive: () => true, sticky });
  const startedFirst = await first.start(request());
  const firstCascade = firstFake.calls.find((c) => c.method === "StartCascade")!.body.cascadeId;
  assert.equal(startedFirst.locator.cascadeId, firstCascade);

  const secondFake = makeFakeFetch();
  const second = createAntigravityAdapter({ fetch: secondFake.fetch, daemonDir: dir, isPidAlive: () => true, sticky });
  const startedSecond = await second.start(request());
  const secondCascade = secondFake.calls.find((c) => c.method === "StartCascade")!.body.cascadeId;

  assert.equal(secondCascade, firstCascade, "the remembered cascade is reused");
  assert.equal(startedSecond.locator.cascadeId, firstCascade);
});

test("an explicit cascadeId always outranks the memory", async () => {
  const dir = daemonDir();
  const sticky = createStickySessions({ file: join(dir, "executor-sessions.json") });
  sticky.remember({ kind: "antigravity", agentId: "agent-ag", workspaceId: "ws-ag" }, "cascade-remembered");

  const fake = makeFakeFetch();
  const adapter = createAntigravityAdapter({ fetch: fake.fetch, daemonDir: dir, isPidAlive: () => true, sticky });
  const started = await adapter.start({ ...request(), cascadeId: "cascade-explicit" });

  assert.equal(fake.calls.find((c) => c.method === "StartCascade")!.body.cascadeId, "cascade-explicit");
  assert.equal(started.locator.cascadeId, "cascade-explicit");
});
