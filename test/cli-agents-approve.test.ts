import assert from "node:assert/strict";
import test from "node:test";

import { UsageError, main, parseArgv } from "../dist/bin/dsh-rpc.mjs";

interface MockCliRpcRequest {
  jsonrpc?: string;
  id?: number | string;
  method: string;
  params: Record<string, unknown>;
}

interface MockCliRpcAnswer {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface MockCliRpcContext {
  calls: MockCliRpcRequest[];
  getStdout: () => string;
  getStderr: () => string;
}

function withMockCliRpc(
  responder: (req: MockCliRpcRequest) => MockCliRpcAnswer | Promise<MockCliRpcAnswer>,
  fn: (ctx: MockCliRpcContext) => Promise<void>,
) {
  const prevFetch = globalThis.fetch;
  const prevUrl = process.env.DSH_RPC_URL;
  const prevToken = process.env.DSH_RPC_TOKEN;
  const prevWrite = process.stdout.write;
  const prevErrWrite = process.stderr.write;

  process.env.DSH_RPC_URL = "http://127.0.0.1:1/dsh-rpc";
  process.env.DSH_RPC_TOKEN = "cli-approve-test-token-0123456789";

  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  const calls: MockCliRpcRequest[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    const req = JSON.parse(String(init.body ?? "{}")) as MockCliRpcRequest;
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
  }) as unknown as typeof globalThis.fetch;

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

test("parseArgv parses tasks approve flags cleanly", () => {
  const parsed = parseArgv([
    "tasks",
    "approve",
    "--task",
    "task_1",
    "--attempt",
    "att_1",
    "--approval",
    "apr_1",
    "--decision",
    "allow",
    "--reason",
    "safe",
    "--json",
  ]);
  const flags = parsed.flags as unknown as Record<string, unknown>;
  assert.deepEqual(parsed.positional, ["tasks", "approve"]);
  assert.equal(flags.task, "task_1");
  assert.equal(flags.attempt, "att_1");
  assert.equal(flags.approval, "apr_1");
  assert.equal(flags.decision, "allow");
  assert.equal(flags.reason, "safe");
  assert.equal(flags.json, true);
});

test("tasks approve rejects missing or invalid flags with UsageError (exit 2)", async () => {
  await assert.rejects(() => main(["tasks", "approve"]), UsageError);
  await assert.rejects(() => main(["tasks", "approve", "--task", "t1"]), UsageError);
  await assert.rejects(() => main(["tasks", "approve", "--task", "t1", "--attempt", "a1"]), UsageError);
  await assert.rejects(
    () => main(["tasks", "approve", "--task", "t1", "--attempt", "a1", "--approval", "apr1"]),
    UsageError,
  );
  await assert.rejects(
    () =>
      main([
        "tasks",
        "approve",
        "--task",
        "t1",
        "--attempt",
        "a1",
        "--approval",
        "apr1",
        "--decision",
        "allow-once",
      ]),
    UsageError,
  );
});

test("CLI tasks approve and agents commands invoke matching RPCs and honor --json / errors", async () => {
  await withMockCliRpc(
    (req) => {
      if (req.method === "dsh.tasks.decideApproval") {
        if (req.params.approvalId === "bad") {
          return { error: { code: -32004, message: "approval not found" } };
        }
        return {
          result: {
            taskId: req.params.taskId,
            attemptId: req.params.attemptId,
            approvalId: req.params.approvalId,
            decision: req.params.decision === "allow" ? "allow-once" : "reject",
            status: "running",
            stateVersion: 4,
          },
        };
      }
      if (req.method === "dsh.agents.register") {
        return { result: { agentId: "ag_dsh", probeStatus: "unverified" } };
      }
      if (req.method === "dsh.agents.list") {
        return { result: { total: 1, items: [{ agentId: "ag_dsh", kind: "dsh", probeStatus: "verified" }] } };
      }
      if (req.method === "dsh.agents.probe") {
        return { result: { agentId: req.params.agentId, probeStatus: "verified", unknown: [] } };
      }
      return { result: {} };
    },
    async ({ calls, getStdout }) => {
      const codeApprove = await main([
        "tasks",
        "approve",
        "--task",
        "task_1",
        "--attempt",
        "att_1",
        "--approval",
        "apr_1",
        "--decision",
        "allow",
        "--reason",
        "checked",
        "--json",
      ]);
      assert.equal(codeApprove, 0);
      assert.equal(calls[0].method, "dsh.tasks.decideApproval");
      assert.deepEqual(calls[0].params, {
        taskId: "task_1",
        attemptId: "att_1",
        approvalId: "apr_1",
        decision: "allow",
        reason: "checked",
      });

      const codeReg = await main([
        "agents",
        "register",
        JSON.stringify({ identity: { agentId: "ag_dsh", kind: "dsh", version: "1.0" }, limitations: [] }),
        "--json",
      ]);
      assert.equal(codeReg, 0);
      assert.equal(calls[1].method, "dsh.agents.register");

      const codeList = await main(["agents", "list", "--kind", "dsh", "--verified-only"]);
      assert.equal(codeList, 0);
      assert.equal(calls[2].method, "dsh.agents.list");

      const codeProbe = await main(["agents", "probe", "--agent", "ag_dsh", "--controls", "start,cancel"]);
      assert.equal(codeProbe, 0);
      assert.equal(calls[3].method, "dsh.agents.probe");

      await assert.rejects(
        () =>
          main([
            "tasks",
            "approve",
            "--task",
            "task_1",
            "--attempt",
            "att_1",
            "--approval",
            "bad",
            "--decision",
            "deny",
          ]),
        /approval not found/,
      );

      assert.match(getStdout(), /"approvalId": "apr_1"/);
    },
  );
});
