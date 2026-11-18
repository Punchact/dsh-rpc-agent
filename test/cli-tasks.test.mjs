import assert from "node:assert/strict";
import test from "node:test";

import { UsageError, main, mixedVersionHint, parseArgv } from "../bin/dsh-rpc.mjs";
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