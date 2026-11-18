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