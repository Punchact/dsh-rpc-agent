import assert from "node:assert/strict";
import test from "node:test";

import { TASK_TOOLS, callTool, listTools, resetBridgeDefaults } from "../bin/dsh-rpc-mcp.mjs";

function withMockRpc(responder, fn) {
  const prevFetch = globalThis.fetch;
  const prevUrl = process.env.DSH_RPC_URL;
  const prevToken = process.env.DSH_RPC_TOKEN;
  process.env.DSH_RPC_URL = "http://127.0.0.1:1/dsh-rpc";
  process.env.DSH_RPC_TOKEN = "mcp-test-token-0123456789abcdef";

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
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = prevFetch;
      if (prevUrl === undefined) delete process.env.DSH_RPC_URL;
      else process.env.DSH_RPC_URL = prevUrl;
      if (prevToken === undefined) delete process.env.DSH_RPC_TOKEN;
      else process.env.DSH_RPC_TOKEN = prevToken;
      resetBridgeDefaults();
    });
}

test("MCP hides task tools when tasksEnabled=false and refuses direct calls with a clear disabled message", async () => {
  resetBridgeDefaults();
  await withMockRpc(
    (req) => {
      if (req.method === "dsh.discover") {
        return { result: { config: { tasksEnabled: false }, methods: [] } };
      }
      return { error: { code: -32601, message: "unknown method" } };
    },
    async () => {
      const tools = await listTools();
      const names = tools.map((t) => t.name);
      for (const taskTool of TASK_TOOLS) {
        assert.equal(names.includes(taskTool.name), false, `${taskTool.name} must be hidden when disabled`);
      }

      const callRes = await callTool("dsh_tasks_submit", { workspace_id: "local" });
      assert.equal(callRes.isError, true);
      assert.match(callRes.content[0].text, /task centre is disabled/i);
      assert.doesNotMatch(callRes.content[0].text, /unknown tool/i);
    },
  );
});

test("MCP exposes task tools when tasksEnabled=true, never exposes reconcile/decideApproval, and formats task summaries", async () => {
  resetBridgeDefaults();
  await withMockRpc(
    (req) => {
      if (req.method === "dsh.discover") {
        return {
          result: {
            config: { tasksEnabled: true },
            methods: [{ name: "dsh.tasks.list" }, { name: "dsh.tasks.submit" }],
          },
        };
      }
      if (req.method === "dsh.tasks.submit") {
        return {
          result: {
            taskId: "task_abc",
            status: "queued",
            phase: "machine/queued",
            stateVersion: 1,
            agentId: "ag-1",
            workspaceId: "local",
          },
        };
      }
      return { result: {} };
    },
    async () => {
      const tools = await listTools();
      const names = tools.map((t) => t.name);
      for (const want of [
        "dsh_tasks_submit",
        "dsh_tasks_list",
        "dsh_tasks_get",
        "dsh_tasks_cancel",
        "dsh_agents_list",
        "dsh_agents_probe",
      ]) {
        assert.ok(names.includes(want), `missing ${want}`);
      }
      assert.equal(names.some((n) => /reconcile|decideApproval|decide_approval/i.test(n)), false);

      const res = await callTool("dsh_tasks_submit", {
        workspace_id: "local",
        agent_id: "ag-1",
        capability_revision_id: "cap-1",
        prompt: "run review",
      });
      assert.equal(res.isError, false);
      assert.equal(res.content[0].text, "task task_abc · queued · machine/queued");
      assert.equal(res.structuredContent.taskId, "task_abc");
    },
  );
});

test("MCP falls back to probing dsh.tasks.list when dsh.discover omits tasksEnabled", async () => {
  resetBridgeDefaults();
  await withMockRpc(
    (req) => {
      if (req.method === "dsh.discover") return { result: { config: {} } };
      if (req.method === "dsh.tasks.list") return { error: { code: -32601, message: "unknown method" } };
      return { result: {} };
    },
    async () => {
      const tools = await listTools();
      assert.equal(tools.some((t) => t.name === "dsh_tasks_submit"), false);
    },
  );
});

test("MCP validates task/session inputs upfront and sanitizes adapter errors", async () => {
  resetBridgeDefaults();
  await withMockRpc(
    (req) => {
      if (req.method === "dsh.discover") {
        return {
          result: { config: { tasksEnabled: true }, methods: [{ name: "dsh.tasks.list" }] },
        };
      }
      if (req.method === "dsh.agents.probe") {
        return {
          error: {
            code: -32000,
            message: "raw http://127.0.0.1:4035 csrf=secret_leak_xyz",
            data: { kind: "ADAPTER_UNAVAILABLE" },
          },
        };
      }
      return { result: {} };
    },
    async (calls) => {
      const beforeCount = calls.length;
      const badArrayInput = await callTool("dsh_tasks_submit", {
        workspace_id: "local",
        agent_id: "ag-1",
        capability_revision_id: "cap-1",
        input: ["not", "an", "object"],
      });
      assert.equal(badArrayInput.isError, true);

      const badNullInput = await callTool("dsh_tasks_submit", {
        workspace_id: "local",
        agent_id: "ag-1",
        capability_revision_id: "cap-1",
        input: null,
      });
      assert.equal(badNullInput.isError, true);

      const badLimitLow = await callTool("dsh_tasks_list", { limit: 0 });
      assert.equal(badLimitLow.isError, true);
      const badLimitHigh = await callTool("dsh_tasks_list", { limit: 201 });
      assert.equal(badLimitHigh.isError, true);

      const badTaskId = await callTool("dsh_tasks_get", { task_id: "   " });
      assert.equal(badTaskId.isError, true);

      const badSessionId = await callTool("dsh_ask", { prompt: "hi", session_id: "  " });
      assert.equal(badSessionId.isError, true);

      // None of the invalid inputs above may hit the task/ask RPC endpoints
      assert.equal(
        calls.slice(beforeCount).some((c) => c.method !== "dsh.discover"),
        false,
      );

      // ADAPTER_UNAVAILABLE RPC error must be sanitized before reaching MCP client
      const probeErr = await callTool("dsh_agents_probe", { agent_id: "ag-ag" });
      assert.equal(probeErr.isError, true);
      assert.doesNotMatch(probeErr.content[0].text, /4035|secret_leak_xyz/);
    },
  );
});
