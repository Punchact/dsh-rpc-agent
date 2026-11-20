import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  BASE_TOOLS,
  CLIENT_TRANSPORT_CODES,
  TASK_TOOLS,
  callTool,
  listTools,
  resetBridgeDefaults,
  validateToolArgs,
} from "../dist/bin/dsh-rpc-mcp.mjs";

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

      const callRes = await callTool("dsh_task_submit", { workspace_id: "local" });
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
        "dsh_task_submit",
        "dsh_task_list",
        "dsh_task_get",
        "dsh_task_cancel",
        "dsh_task_preview",
        "dsh_task_events",
        "dsh_task_read_artifact",
        "dsh_task_input",
        "dsh_agents_list",
        "dsh_agents_probe",
        "dsh_agents_get",
      ]) {
        assert.ok(names.includes(want), `missing ${want}`);
      }
      assert.equal(names.some((n) => /reconcile|decideApproval|decide_approval/i.test(n)), false);

      const res = await invokeTool("dsh_task_submit", {
        workspace_id: "local",
        agent_id: "ag-1",
        capability_revision_id: "cap-1",
        prompt: "run review",
      });
      assert.equal(res.isError, false);
      assert.equal(res.content[0].text, "task task_abc · queued · machine/queued");
      assert.equal(res.structuredContent?.taskId, "task_abc");
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
      assert.equal(tools.some((t) => t.name === "dsh_task_submit"), false);
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
      const badArrayInput = await callTool("dsh_task_submit", {
        workspace_id: "local",
        agent_id: "ag-1",
        capability_revision_id: "cap-1",
        input: ["not", "an", "object"],
      });
      assert.equal(badArrayInput.isError, true);

      const badNullInput = await callTool("dsh_task_submit", {
        workspace_id: "local",
        agent_id: "ag-1",
        capability_revision_id: "cap-1",
        input: null,
      });
      assert.equal(badNullInput.isError, true);

      const badLimitLow = await callTool("dsh_task_list", { limit: 0 });
      assert.equal(badLimitLow.isError, true);
      const badLimitHigh = await callTool("dsh_task_list", { limit: 201 });
      assert.equal(badLimitHigh.isError, true);

      const badTaskId = await callTool("dsh_task_get", { task_id: "   " });
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

      // W7 #6: generic schema validation rejects unknown keys, string limit, array for string field
      const beforeW7 = calls.length;
      const unknownField = await callTool("dsh_task_submit", {
        workspace_id: "local",
        unknown_extra: 1,
      });
      assert.equal(unknownField.isError, true);
      assert.match(unknownField.content[0].text, /invalid arguments: unknown_extra/);

      const stringLimit = await callTool("dsh_task_list", { limit: "10" });
      assert.equal(stringLimit.isError, true);
      assert.match(stringLimit.content[0].text, /invalid arguments: limit/);

      const arrayCwd = await callTool("dsh_sessions", { cwd: ["bad"] });
      assert.equal(arrayCwd.isError, true);
      assert.match(arrayCwd.content[0].text, /invalid arguments: cwd/);

      assert.equal(calls.length, beforeW7);

      // Permissive schema without `additionalProperties: false` allows unknown keys
      const legacySchema = {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      };
      assert.equal(validateToolArgs(legacySchema, { prompt: "hello", extraField: true }), null);
      assert.match(
        validateToolArgs(legacySchema, { extraField: true }),
        /invalid arguments: prompt — `prompt` is required/,
      );
    },
  );
});

test("MCP tells a 0.8.x plugin apart from a disabled 0.9.0 one instead of suggesting tasksEnabled", async () => {
  resetBridgeDefaults();
  await withMockRpc(
    (req) => {
      if (req.method === "dsh.discover") {
        // 0.8.x: no config.tasksEnabled key at all, and no dsh.tasks.* in the catalog.
        return { result: { config: { defaultTimeoutMs: 600000 }, methods: ["dsh.ping", "dsh.sessions.list"] } };
      }
      return { error: { code: -32601, message: "unknown method: " + req.method } };
    },
    async () => {
      const tools = await listTools();
      const names = tools.map((tool) => tool.name);
      for (const taskTool of TASK_TOOLS) {
        assert.equal(
          names.includes(taskTool.name),
          false,
          taskTool.name + " must be hidden on a pre-0.9.0 plugin",
        );
      }

      const res = await callTool("dsh_task_list", {});
      assert.equal(res.isError, true);
      const body = res.content.map((parts: { text: string }) => parts.text).join("\n");
      assert.match(body, /does not implement the task centre/i);
      assert.match(body, /upgrade the plugin inside the DSH profile to 0\.9\.0/i);
      assert.doesNotMatch(
        body,
        /set config\.tasksEnabled=true/,
        "a config hint cannot fix a plugin that predates the task centre",
      );
    },
  );
});

test("MCP refuses prototype keys and schema constraints deeper than the old cap", async () => {
  resetBridgeDefaults();

  // JSON.parse is what a real client does: it stores "__proto__" as an own
  // property. `key in props` is true for it on every plain object, so the
  // additionalProperties check used to wave it through.
  const protoArgs = JSON.parse('{"session_id":"s-1","__proto__":{"polluted":true}}');
  const protoErr = validateToolArgs(
    { type: "object", properties: { session_id: { type: "string" } }, additionalProperties: false },
    protoArgs,
  );
  assert.match(String(protoErr), /unknown property "__proto__"/);

  const ctorErr = validateToolArgs(
    { type: "object", properties: {}, additionalProperties: false },
    { constructor: { polluted: true } },
  );
  assert.match(String(ctorErr), /unknown property "constructor"/);

  // Constraints three levels down must still be checked: the recursion cap was 2.
  const deepSchema = {
    type: "object",
    properties: {
      a: {
        type: "object",
        properties: {
          b: { type: "object", properties: { c: { type: "object", properties: { d: { type: "integer", minimum: 10 } } } } },
        },
      },
    },
  };
  assert.equal(validateToolArgs(deepSchema, { a: { b: { c: { d: 42 } } } }), null);
  assert.match(
    String(validateToolArgs(deepSchema, { a: { b: { c: { d: 3 } } } })),
    /a\.b\.c\.d — must be >= 10/,
  );
});

test("MCP dsh_task_preview and dsh_task_list surface preview headers, degraded, pending, and resultValid", async () => {
  resetBridgeDefaults();
  await withMockRpc(
    (req) => {
      if (req.method === "dsh.discover") {
        return { result: { config: { tasksEnabled: true }, methods: [{ name: "dsh.tasks.list" }] } };
      }
      if (req.method === "dsh.tasks.preview") {
        return {
          result: {
            previewId: "pv_mcp_1",
            agentId: "ag-1",
            workspaceId: "local",
            capabilityRevisionId: "rev-1",
            degraded: [{ control: "cancel", effect: "no cancel" }],
            expiresAt: "2026-11-19T20:00:00.000Z",
          },
        };
      }
      if (req.method === "dsh.tasks.list") {
        return {
          result: {
            items: [
              {
                taskId: "t_bad",
                status: "succeeded",
                phase: "done/Finished",
                resultValid: false,
                degraded: [{ control: "cancel" }],
                pending: { attention: [{ questionId: "q_1" }], approvals: [{ approvalId: "ap_1" }] },
              },
            ],
            hasMore: false,
          },
        };
      }
      return { result: {} };
    },
    async () => {
      const previewRes = await callTool("dsh_task_preview", {
        workspace_id: "local",
        agent_id: "ag-1",
        capability_revision_id: "rev-1",
      });
      assert.equal(previewRes.isError, false);
      assert.match(previewRes.content[0].text, /^preview pv_mcp_1 · ag-1 · expires /);
      assert.doesNotMatch(previewRes.content[0].text, /task \? · unknown/);
      assert.match(previewRes.content[1].text, /degraded \(1\): cancel/);

      const listRes = await callTool("dsh_task_list", {});
      assert.equal(listRes.isError, false);
      assert.match(
        listRes.content[1].text,
        /task t_bad · succeeded · done\/Finished \[unvalidated · degraded\(cancel\) · attention=1 · approvals=1\]/,
      );
    },
  );
});

test("MCP task tools pass client transport errors (EBADPORT, ECONNREFUSED) through verbatim instead of adapter-sanitizing them", async () => {
  const cases: Array<[Error, RegExp]> = [
    [new Error("bad port"), /EBADPORT/],
    [Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }), /ECONNREFUSED/],
  ];
  for (const [cause, expectPattern] of cases) {
    resetBridgeDefaults();
    const prevFetch = globalThis.fetch;
    const prevUrl = process.env.DSH_RPC_URL;
    const prevToken = process.env.DSH_RPC_TOKEN;
    process.env.DSH_RPC_URL = "http://127.0.0.1:1/dsh-rpc";
    process.env.DSH_RPC_TOKEN = "mcp-test-token-0123456789abcdef";

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body ?? "{}")) as MockRpcRequest;
      if (req.method === "dsh.discover") {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              jsonrpc: "2.0",
              id: req.id,
              result: { config: { tasksEnabled: true }, methods: [{ name: "dsh.tasks.list" }] },
            });
          },
        };
      }
      throw new TypeError("fetch failed", { cause });
    }) as unknown as typeof fetch;

    try {
      const res = await callTool("dsh_task_list", {});
      assert.equal(res.isError, true);
      const text = res.content.map((p: { text: string }) => p.text).join("\n");
      assert.match(text, expectPattern);
      assert.doesNotMatch(text, /request rejected by adapter|executor is currently unavailable/);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevUrl === undefined) delete process.env.DSH_RPC_URL;
      else process.env.DSH_RPC_URL = prevUrl;
      if (prevToken === undefined) delete process.env.DSH_RPC_TOKEN;
      else process.env.DSH_RPC_TOKEN = prevToken;
      resetBridgeDefaults();
    }
  }
});
test("a client transport failure passes through with a next step, an adapter errno never rides along", async () => {
  resetBridgeDefaults();
  await withMockRpc(
    (req) => {
      if (req.method === "dsh.discover") {
        return { result: { config: { tasksEnabled: true }, methods: [{ name: "dsh.tasks.list" }] } };
      }
      if (req.method === "dsh.tasks.get") {
        // 客户端侧连不上：抛出去才是真实形状，fetch 失败不会变成一条 JSON-RPC 错误。
        const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4035"), { code: "ECONNREFUSED" });
        throw Object.assign(new TypeError("fetch failed"), { cause });
      }
      if (req.method === "dsh.tasks.list") {
        // 执行方/子进程的 errno 带着绝对路径，它没有 transport 标记，必须继续净化。
        return { error: { code: "ENOENT", message: "spawn C:\\Users\\Andy\\AppData\\Local\\fake\\codex.exe ENOENT" } };
      }
      return { result: {} };
    },
    async () => {
      const refused = await callTool("dsh_task_get", { task_id: "task_x" });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /127\.0\.0\.1:4035/);
      assert.match(refused.content[0].text, /next: nothing answered on that port/);

      const adapter = await callTool("dsh_task_list", {});
      assert.equal(adapter.isError, true);
      assert.doesNotMatch(adapter.content[0].text, /AppData|codex\.exe/);
      assert.match(adapter.content[0].text, /execution backend (rejected|did not)/);
    },
  );
});

test("BASE_TOOLS (11), TASK_TOOLS (11), CLIENT_TRANSPORT_CODES, and MCP schema types enforce compile-time contracts in memory", () => {
  assert.equal(BASE_TOOLS.length, 11);
  assert.equal(TASK_TOOLS.length, 11);
  assert.equal(CLIENT_TRANSPORT_CODES.has("EBADPORT"), true);
  assert.equal(CLIENT_TRANSPORT_CODES.has("ENOENT"), false);

  const repoRoot = resolve(import.meta.dirname, "..");
  const configPath = resolve(repoRoot, "tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    repoRoot,
  );
  const options = { ...parsed.options, noEmit: true, incremental: false, composite: false, declaration: false };
  const validFile = resolve(repoRoot, "src/__mcp_valid_probe__.mts");
  const badFile = resolve(repoRoot, "src/__mcp_bad_probe__.mts");

  const validSource = `
import {
  BASE_TOOLS,
  CLIENT_TRANSPORT_CODES,
  TASK_TOOLS,
  type BaseToolName,
  type ClientTransportCode,
  type McpCallToolOutcome,
  type McpToolDefinition,
  type TaskToolName,
} from "./bin/dsh-rpc-mcp.mjs";
import { formatTaskSummary, NEXT_BY_CODE, type KnownNextCode } from "./lib/mcp-format.mjs";

const baseName: BaseToolName = "dsh_ask";
const taskName: TaskToolName = "dsh_task_submit";
const code: ClientTransportCode = "ECONNREFUSED";
const nextKey: KnownNextCode = "EBADPORT";
const baseList: readonly McpToolDefinition[] = BASE_TOOLS;
const taskList: readonly McpToolDefinition[] = TASK_TOOLS;
const hasCode: boolean = CLIENT_TRANSPORT_CODES.has(code);
const outcome: McpCallToolOutcome = formatTaskSummary({ taskId: "t1", status: "queued", phase: "machine/queued" });
const hint: string = NEXT_BY_CODE[nextKey];
void baseName; void taskName; void baseList; void taskList; void hasCode; void outcome; void hint;
`;

  const badSource = `
import {
  CLIENT_TRANSPORT_CODES,
  type BaseToolName,
  type ClientTransportCode,
  type McpToolDefinition,
} from "./bin/dsh-rpc-mcp.mjs";

const badTool: BaseToolName = "dsh_unknown_tool";
const badEntry: McpToolDefinition = {
  name: "dsh_extra",
  title: "Extra",
  description: "Extra tool",
  extraUnknownField: true,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const badTransport: ClientTransportCode = "ENOENT";
CLIENT_TRANSPORT_CODES.add("EBADPORT");
void badTool; void badEntry; void badTransport;
`;

  const sources = new Map([
    [validFile, validSource],
    [badFile, badSource],
  ]);
  const host = ts.createCompilerHost(options, true);
  const origGetSourceFile = host.getSourceFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  const origReadFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const resolved = resolve(fileName);
    const virtual = sources.get(resolved);
    if (virtual !== undefined) return ts.createSourceFile(fileName, virtual, languageVersion, true);
    return origGetSourceFile(fileName, languageVersion, onError, shouldCreate);
  };
  host.fileExists = (fileName) => sources.has(resolve(fileName)) || origFileExists(fileName);
  host.readFile = (fileName) => sources.get(resolve(fileName)) ?? origReadFile(fileName);
  host.writeFile = () => {
    throw new Error("the MCP type probe must never write to disk");
  };

  const program = ts.createProgram([validFile, badFile], options, host);
  const collect = (rootFile: string) => {
    const sf = program.getSourceFile(rootFile);
    if (!sf) throw new Error(`tsc did not load probe ${rootFile}`);
    return ts
      .getPreEmitDiagnostics(program, sf)
      .filter((d) => d.file === sf)
      .map((d) => ({ code: d.code, text: ts.flattenDiagnosticMessageText(d.messageText, " ") }));
  };

  const validDiags = collect(validFile);
  assert.deepEqual(
    validDiags,
    [],
    `valid MCP probe must compile cleanly, got: ${validDiags.map((d) => `TS${d.code}:${d.text}`).join("; ")}`,
  );

  const badDiags = collect(badFile);
  const codes = new Set(badDiags.map((d) => d.code));
  const summary = badDiags.map((d) => `TS${d.code}:${d.text}`).join(" | ");
  assert.ok(badDiags.length >= 4, `expected >= 4 tsc errors, got ${badDiags.length}: ${summary}`);
  assert.ok(codes.has(2322), `expected TS2322 for invalid BaseToolName / ClientTransportCode: ${summary}`);
  assert.ok(codes.has(2353), `expected TS2353 for extraUnknownField on McpToolDefinition: ${summary}`);
  assert.ok(codes.has(2339), `expected TS2339 for CLIENT_TRANSPORT_CODES.add (ReadonlySet): ${summary}`);
  assert.ok(badDiags.some((d) => d.text.includes("dsh_unknown_tool")), `expected dsh_unknown_tool diagnostic: ${summary}`);
  assert.ok(badDiags.some((d) => d.text.includes("extraUnknownField")), `expected extraUnknownField diagnostic: ${summary}`);
  assert.ok(badDiags.some((d) => d.text.includes("ENOENT")), `expected ENOENT diagnostic: ${summary}`);
});