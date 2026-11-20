import assert from "node:assert/strict";
import test from "node:test";

import { BASE_TOOLS, callTool, resetBridgeDefaults } from "../dist/bin/dsh-rpc-mcp.mjs";

interface MockRpcRequest {
  id?: unknown;
  method: string;
  params?: Record<string, unknown>;
}

interface MockRpcReply {
  result?: unknown;
  error?: { code: number | string; message: string; data?: Record<string, unknown> };
}

interface McpCallOutcome {
  isError: boolean;
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
}

const invokeTool = callTool as (name: string, args: Record<string, unknown>) => Promise<McpCallOutcome>;

function textOf(outcome: McpCallOutcome): string {
  return outcome.content.map((part) => part.text).join("\n");
}

/** The bridge asks `dsh.discover` once per reset; those frames are plumbing, not the tool under test. */
function pluginCalls(calls: MockRpcRequest[]): MockRpcRequest[] {
  return calls.filter((req) => req.method !== "dsh.discover");
}

function firstPluginCall(calls: MockRpcRequest[]): MockRpcRequest {
  const first = pluginCalls(calls)[0];
  if (first === undefined) throw new Error("expected at least one plugin RPC call");
  return first;
}

/**
 * Same shape as test/mcp-tasks-tools.test.ts: swap global fetch for one that answers the
 * bridge's own JSON-RPC frames, so these assertions are about the tool layer
 * (name → method → params → rendering) and not about a live Harness.
 */
function withMockRpc(
  responder: (req: MockRpcRequest) => MockRpcReply | Promise<MockRpcReply>,
  fn: (calls: MockRpcRequest[]) => Promise<void>,
) {
  const prevFetch = globalThis.fetch;
  const prevUrl = process.env.DSH_RPC_URL;
  const prevToken = process.env.DSH_RPC_TOKEN;
  process.env.DSH_RPC_URL = "http://127.0.0.1:1/dsh-rpc";
  process.env.DSH_RPC_TOKEN = "mcp-test-token-0123456789abcdef";

  const calls: MockRpcRequest[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body ?? "{}")) as MockRpcRequest;
    calls.push(req);
    const ans =
      req.method === "dsh.discover"
        ? { result: { config: { tasksEnabled: true }, methods: [] } }
        : await responder(req);
    const payload = "error" in ans && ans.error
      ? { jsonrpc: "2.0", id: req.id, error: ans.error }
      : { jsonrpc: "2.0", id: req.id, result: (ans as MockRpcReply).result ?? {} };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(payload);
      },
    };
  }) as unknown as typeof fetch;

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

test("the five base tools are registered under the names callers are told to use", async () => {
  const names = BASE_TOOLS.map((tool) => tool.name);
  for (const expected of ["dsh_status", "dsh_workspaces", "dsh_capabilities", "dsh_permissions", "dsh_approvals_pending"]) {
    assert.equal(names.includes(expected), true, `${expected} must be exposed`);
  }
});

test("dsh_status asks dsh.ping and prints the four lines it promises", async () => {
  await withMockRpc(
    () => ({
      result: {
        plugin: "dsh-rpc-agent",
        version: "0.9.4",
        origin: "http://127.0.0.1:3318",
        config: { path: "/dsh-rpc" },
        state: { tokenSource: "file" },
        activeRuns: [{}, {}],
      },
    }),
    async (calls) => {
      const out = await invokeTool("dsh_status", {});
      assert.equal(out.isError, false);
      const first = firstPluginCall(calls);
      assert.equal(first.method, "dsh.ping");
      assert.deepEqual(first.params, {});
      const text = textOf(out);
      assert.match(text, /plugin: dsh-rpc-agent 0\.9\.4/);
      assert.match(text, /endpoint: http:\/\/127\.0\.0\.1:3318\/dsh-rpc/);
      assert.match(text, /token source: file/);
      assert.match(text, /active runs: 2/);
    },
  );
});

test("dsh_status does not invent an endpoint when ping reports none", async () => {
  await withMockRpc(
    () => ({ result: { plugin: "dsh-rpc-agent", version: "0.9.4", origin: null, state: { tokenSource: "env" } } }),
    async () => {
      const text = textOf(await invokeTool("dsh_status", {}));
      assert.match(text, /endpoint: \?/);
      assert.match(text, /active runs: 0/);
    },
  );
});

test("dsh_workspaces lists through dsh.workspaces.list and keeps id, title, status and path", async () => {
  await withMockRpc(
    () => ({
      result: {
        items: [
          { id: "local", title: "插件项目", status: "ready", sessions: 12, path: "C:\\work\\p" },
          { id: "mgtv", title: "mgtv", status: "missing", sessions: 0, path: "D:\\mgtv" },
        ],
      },
    }),
    async (calls) => {
      const text = textOf(await invokeTool("dsh_workspaces", {}));
      const first = firstPluginCall(calls);
      assert.equal(first.method, "dsh.workspaces.list");
      assert.match(text, /local {2}插件项目 {2}\[ready, 12 sessions\]/);
      assert.match(text, /C:\\work\\p/);
      assert.match(text, /mgtv {2}mgtv {2}\[missing, 0 sessions\]/);
    },
  );
});

test("dsh_workspaces says so when the Harness has no workspace yet", async () => {
  await withMockRpc(
    () => ({ result: {} }),
    async () => {
      assert.equal(textOf(await invokeTool("dsh_workspaces", {})), "(no workspaces registered)");
    },
  );
});

test("dsh_workspaces registers a directory and forwards the title only when one was given", async () => {
  await withMockRpc(
    () => ({ result: { id: "ws-1", title: "插件项目", path: "C:\\work\\p" } }),
    async (calls) => {
      const text = textOf(await invokeTool("dsh_workspaces", { path: " C:\\work\\p ", title: " 插件项目 " }));
      const first = firstPluginCall(calls);
      assert.equal(first.method, "dsh.workspaces.create");
      assert.deepEqual(first.params, { path: "C:\\work\\p", title: "插件项目" });
      assert.equal(text, "workspace ws-1  插件项目\nC:\\work\\p");
    },
  );
  await withMockRpc(
    () => ({ result: { id: "ws-2", title: "p", path: "C:\\work\\p" } }),
    async (calls) => {
      await invokeTool("dsh_workspaces", { path: "C:\\work\\p" });
      const first = firstPluginCall(calls);
      assert.deepEqual(first.params, { path: "C:\\work\\p" }, "no title means no title key at all");
    },
  );
});

test("dsh_permissions marks the default preset and keeps the deployment's order", async () => {
  await withMockRpc(
    () => ({
      result: {
        defaultPreset: "workspace-write",
        options: [
          { value: "read-only", name: "Read only", description: null },
          { value: "workspace-write", name: "Workspace write", description: "may edit the workspace" },
        ],
      },
    }),
    async (calls) => {
      const lines = textOf(await invokeTool("dsh_permissions", {})).split("\n");
      const first = firstPluginCall(calls);
      assert.equal(first.method, "dsh.permissions.catalog");
      assert.equal(lines.length, 2);
      assert.equal(lines[0], "  read-only  Read only");
      assert.equal(lines[1], "* workspace-write  Workspace write — may edit the workspace");
    },
  );
});

test("dsh_permissions says the deployment offers nothing instead of printing an empty page", async () => {
  await withMockRpc(
    () => ({ result: { defaultPreset: null, options: [] } }),
    async () => {
      assert.equal(textOf(await invokeTool("dsh_permissions", {})), "(this deployment exposes no permission presets)");
    },
  );
});

test("dsh_approvals_pending explains a bridge that cannot hold escalations", async () => {
  await withMockRpc(
    () => ({ result: { pending: [], mode: "off", timedOut: false } }),
    async (calls) => {
      const text = textOf(await invokeTool("dsh_approvals_pending", {}));
      const first = firstPluginCall(calls);
      assert.equal(first.method, "dsh.approvals.pending");
      assert.match(text, /does not hold escalations: approvals\.mode=off/);
    },
  );
});

test("dsh_approvals_pending forwards wait_ms as waitMs and session_id as sessionId", async () => {
  await withMockRpc(
    () => ({ result: { pending: [], mode: "delegate", timedOut: true } }),
    async (calls) => {
      await invokeTool("dsh_approvals_pending", { session_id: " session-1 ", wait_ms: 500 });
      const first = firstPluginCall(calls);
      assert.deepEqual(first.params, { sessionId: "session-1", waitMs: 500 });
    },
  );
});

test("dsh_approvals_pending shows the whole call, not just the command", async () => {
  await withMockRpc(
    () => ({
      result: {
        mode: "delegate",
        pending: [
          {
            approvalId: "ap-1",
            sessionId: "session-1",
            toolName: "write_file",
            escalation: "workspace-write",
            args: '{"path":"a.txt","content":"secret-ish payload"}',
            argv: "pwsh -c ...",
            cwd: "C:\\work\\p",
            preset: "workspace-write",
            reason: "needs to write a file",
            expiresAt: "2026-11-20T00:00:00Z",
          },
        ],
      },
    }),
    async () => {
      const text = textOf(await invokeTool("dsh_approvals_pending", {}));
      assert.match(text, /ap-1 {2}session-1 {2}write_file → workspace-write/);
      assert.match(text, /call: \{"path":"a\.txt"/, "the payload half of a write must be visible");
      assert.match(text, /cwd: C:\\work\\p/);
    },
  );
});

test("dsh_approvals_pending refuses an empty session_id instead of listing everything", async () => {
  await withMockRpc(
    () => ({ result: { pending: [], mode: "delegate" } }),
    async (calls) => {
      const out = await invokeTool("dsh_approvals_pending", { session_id: "   " });
      assert.equal(out.isError, true);
      assert.match(textOf(out), /`session_id` must be a non-empty string/);
      assert.deepEqual(pluginCalls(calls), [], "a blank filter must not reach the plugin");
    },
  );
});

test("dsh_capabilities forwards the snake_case contract and prefers the plugin's own text", async () => {
  await withMockRpc(
    () => ({
      result: {
        text: "## runtime\nnode v24.22.3",
        sections: [{ id: "runtime" }],
        truncated: true,
        missing: ["plugins"],
      },
    }),
    async (calls) => {
      const out = await invokeTool("dsh_capabilities", {
        sections: ["runtime"],
        max_chars: 4000,
        session_id: " session-1 ",
      });
      const first = firstPluginCall(calls);
      assert.equal(first.method, "dsh.capabilities");
      assert.deepEqual(first.params, { sections: ["runtime"], max_chars: 4000, session_id: "session-1" });
      assert.equal(textOf(out), "## runtime\nnode v24.22.3");
      assert.deepEqual(out.structuredContent, {
        sections: [{ id: "runtime" }],
        truncated: true,
        missing: ["plugins"],
      });
    },
  );
});

test("dsh_capabilities names the stale half when the plugin predates the method", async () => {
  await withMockRpc(
    () => ({ error: { code: -32601, message: "unknown method: dsh.capabilities" } }),
    async () => {
      const out = await invokeTool("dsh_capabilities", {});
      assert.equal(out.isError, true);
      const text = textOf(out);
      assert.match(text, /does not implement dsh\.capabilities/);
      assert.match(text, /upgrade the plugin/, "the error must say which side to upgrade");
    },
  );
});

test("dsh_capabilities reports a real failure verbatim instead of calling it a version mismatch", async () => {
  await withMockRpc(
    () => ({ error: { code: -32603, message: "internal error: boom" } }),
    async () => {
      const out = await invokeTool("dsh_capabilities", {});
      assert.equal(out.isError, true);
      const text = textOf(out);
      assert.match(text, /internal error: boom/);
      assert.equal(/upgrade the plugin/.test(text), false, "a real failure must not be rewritten as a version hint");
    },
  );
});

test("dsh_capabilities rejects a non-string session_id before calling the plugin", async () => {
  await withMockRpc(
    () => ({ result: {} }),
    async (calls) => {
      const out = await invokeTool("dsh_capabilities", { session_id: 42 });
      assert.equal(out.isError, true);
      assert.match(textOf(out), /invalid arguments: session_id — expected string/);
      assert.deepEqual(pluginCalls(calls), [], "schema violations must not reach the plugin");
    },
  );
});
