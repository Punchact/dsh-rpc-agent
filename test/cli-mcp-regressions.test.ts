import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { closeServer, listenSafe } from "./helpers/stub-server.ts";

import type { Server } from "node:http";

interface CliEnvelope {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: { timeoutMs?: number; since?: number; [key: string]: unknown };
}

interface McpToolResponse {
  id?: number;
  result?: {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  error?: {
    code?: number;
    message?: string;
  };
}

const REPO = fileURLToPath(new URL("..", import.meta.url));
const token = "cli-mcp-regression-token-0123456789";
const home = mkdtempSync(join(tmpdir(), "dsh-rpc-cli-mcp-"));
const state = join(home, "dsh-rpc");
mkdirSync(state, { recursive: true });
writeFileSync(join(state, "token"), token);
const endpointFile = join(state, "endpoint.json");
let server: Server | undefined;
let calls: CliEnvelope[] = [];
let responseBody: string | ((envelope: CliEnvelope) => string) = "{}";
let responseStatus = 200;

after(async () => {
  if (server) await closeServer(server);
  rmSync(home, { recursive: true, force: true });
});

async function startServer() {
  calls = [];
  responseBody = "{}";
  responseStatus = 200;
  const bound = await listenSafe(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const envelope = JSON.parse(raw) as CliEnvelope;
    calls.push(envelope);
    response.statusCode = responseStatus;
    response.setHeader("content-type", "application/json");
    response.end(typeof responseBody === "function" ? responseBody(envelope) : responseBody);
  });
  server = bound.server;
  const url = bound.url;
  writeFileSync(endpointFile, JSON.stringify({ url, origin: url.replace(/\/dsh-rpc$/, ""), path: "/dsh-rpc" }));
}

function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO, "dist", "bin", "dsh-rpc.mjs"), ...args], {
      cwd: REPO,
      env: { ...process.env, DSH_HOME: home, DSH_RPC_TOKEN: "", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => (stdout += text));
    child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function rpcResult(envelope: CliEnvelope, result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result });
}

await startServer();

test("prompt forwards model, effort, and permission settings", async () => {
  responseBody = (envelope) => rpcResult(envelope, { requestId: "r-1" });
  const result = await runCli([
    "prompt", "--session", "s-1", "--model", "provider/model-a", "--effort", "high", "--permission", "standard", "hello",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(calls.at(-1)?.params, {
    sessionId: "s-1", text: "hello", model: "provider/model-a", reasoningEffort: "high", permissionPreset: "standard",
  });
});

test("raw call wait lets timeoutMs in JSON define its slice and transport budget", async () => {
  responseBody = (envelope) => rpcResult(envelope, { status: "completed", sessionId: "s", text: "done" });
  const result = await runCli(["call", "dsh.sessions.wait", JSON.stringify({ sessionId: "s", timeoutMs: 1234, since: 0 })]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls.at(-1)?.params?.timeoutMs, 1234);
  assert.equal(calls.at(-1)?.params?.since, 0);
});

test("raw call --timeout overrides the JSON timeoutMs", async () => {
  responseBody = (envelope) => rpcResult(envelope, { status: "completed", sessionId: "s", text: "done" });
  const result = await runCli([
    "call", "dsh.sessions.wait", JSON.stringify({ sessionId: "s", timeoutMs: 1234 }), "--timeout", "2345",
  ]);
  assert.equal(result.code, 0, result.stderr);
  // A wait goes through the sliced loop, so the request carries whatever was left of the
  // budget when it was written — the full 2345 minus the elapsed first tick. Assert the
  // override took effect (not the JSON 1234) without pinning a millisecond.
  const forwarded = calls.at(-1)?.params?.timeoutMs;
  assert.equal(typeof forwarded, "number");
  assert.ok(forwarded! >= 2000, `the first slice must be nearly the whole budget, got ${forwarded}`);
  assert.ok(forwarded! <= 2345, `a wait must never ask for more than its budget, got ${forwarded}`);
});

test("wait accepts since zero and forwards it", async () => {
  responseBody = (envelope) => rpcResult(envelope, { status: "completed", sessionId: "s", text: "done", cursor: 0 });
  const result = await runCli([
    "wait", "--session", "s", "--since", "0", "--url", (JSON.parse(readFileSync(endpointFile, "utf8")) as { url: string }).url, "--token", token,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls.at(-1)?.params?.since, 0);
});

test("env leaves an existing token untouched", async () => {
  const result = await runCli(["env"], { DSH_RPC_TOKEN: "already-configured-token" });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /export DSH_RPC_TOKEN=/);
  assert.doesNotMatch(result.stdout, /already-configured-token/);
});

test("env emits a shell command substitution with a safely quoted path", async () => {
  const result = await runCli(["env"], { DSH_RPC_TOKEN: "" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^export DSH_RPC_TOKEN="\$\(cat '/m);
  assert.doesNotMatch(result.stdout, /export DSH_RPC_TOKEN='\$\(cat/);
});

test("HTTP 503 is a failing CLI call, not an empty success", async () => {
  responseStatus = 503;
  responseBody = JSON.stringify({ message: "fixture unavailable" });
  const result = await runCli(["call", "dsh.ping"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /HTTP 503/);
  assert.equal(result.stdout, "");
});

test("MCP approval resolution returns structured tool errors for invalid arguments", async () => {
  const child = spawn(process.execPath, [join(REPO, "dist", "bin", "dsh-rpc-mcp.mjs")], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home, DSH_RPC_TOKEN: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const replies = new Map<number, (message: McpToolResponse) => void>();
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line) as McpToolResponse;
        const resolve = message.id !== undefined ? replies.get(message.id) : undefined;
        if (message.id !== undefined) replies.delete(message.id);
        resolve?.(message);
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", () => {});
  const request = (id: number, params: Record<string, unknown>): Promise<McpToolResponse> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for MCP response ${id}`)), 5000);
      replies.set(id, (message) => { clearTimeout(timer); resolve(message); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params })}\n`);
    });
  try {
    const cases: Array<[number, Record<string, unknown>, RegExp]> = [
      [1, {}, /`approval_id` is required/],
      [2, { approval_id: "approval-x", decision: "maybe" }, /decision.*allow-once.*reject/],
    ];
    for (const [id, args, expected] of cases) {
      const response = await request(id, { name: "dsh_approvals_resolve", arguments: args });
      assert.equal(response.result?.isError, true);
      assert.match(response.result?.content?.[0]?.text ?? "", expected);
    }

    // `arguments` is an object in the MCP schema. Coercing a non-object into "no
    // arguments" let an array reach the tool with defaults, so invalid input
    // looked like a normal call (quality review, 0.9.4 finding 2).
    const nonObject = await request(3, { name: "dsh_approvals_resolve", arguments: [] });
    assert.equal(nonObject.error?.code, -32602);
    assert.match(nonObject.error?.message ?? "", /expected object/);
  } finally {
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
});
