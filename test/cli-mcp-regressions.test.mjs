import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const token = "cli-mcp-regression-token-0123456789";
const home = mkdtempSync(join(tmpdir(), "dsh-rpc-cli-mcp-"));
const state = join(home, "dsh-rpc");
mkdirSync(state, { recursive: true });
writeFileSync(join(state, "token"), token);
const endpointFile = join(state, "endpoint.json");
let server;
let calls = [];
let responseBody = "{}";
let responseStatus = 200;

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
});

async function startServer() {
  calls = [];
  responseBody = "{}";
  responseStatus = 200;
  server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const envelope = JSON.parse(raw);
    calls.push(envelope);
    response.statusCode = responseStatus;
    response.setHeader("content-type", "application/json");
    response.end(typeof responseBody === "function" ? responseBody(envelope) : responseBody);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/dsh-rpc`;
  writeFileSync(endpointFile, JSON.stringify({ url, origin: url.replace(/\/dsh-rpc$/, ""), path: "/dsh-rpc" }));
}

function runCli(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO, "bin", "dsh-rpc.mjs"), ...args], {
      cwd: REPO,
      env: { ...process.env, DSH_HOME: home, DSH_RPC_TOKEN: "", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
    child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function rpcResult(envelope, result) {
  return JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result });
}

await startServer();

test("prompt forwards model, effort, and permission settings", async () => {
  responseBody = (envelope) => rpcResult(envelope, { requestId: "r-1" });
  const result = await runCli([
    "prompt", "--session", "s-1", "--model", "provider/model-a", "--effort", "high", "--permission", "standard", "hello",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(calls.at(-1).params, {
    sessionId: "s-1", text: "hello", model: "provider/model-a", reasoningEffort: "high", permissionPreset: "standard",
  });
});

test("raw call wait lets timeoutMs in JSON define its slice and transport budget", async () => {
  responseBody = (envelope) => rpcResult(envelope, { status: "completed", sessionId: "s", text: "done" });
  const result = await runCli(["call", "dsh.sessions.wait", JSON.stringify({ sessionId: "s", timeoutMs: 1234, since: 0 })]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls.at(-1).params.timeoutMs, 1234);
  assert.equal(calls.at(-1).params.since, 0);
});

test("raw call --timeout overrides the JSON timeoutMs", async () => {
  responseBody = (envelope) => rpcResult(envelope, { status: "completed", sessionId: "s", text: "done" });
  const result = await runCli([
    "call", "dsh.sessions.wait", JSON.stringify({ sessionId: "s", timeoutMs: 1234 }), "--timeout", "2345",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls.at(-1).params.timeoutMs, 2345);
});

test("wait accepts since zero and forwards it", async () => {
  responseBody = (envelope) => rpcResult(envelope, { status: "completed", sessionId: "s", text: "done", cursor: 0 });
  const result = await runCli(["wait", "--session", "s", "--since", "0", "--url", JSON.parse(readFileSync(endpointFile)).url, "--token", token]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls.at(-1).params.since, 0);
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
  const child = spawn(process.execPath, [join(REPO, "bin", "dsh-rpc-mcp.mjs")], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home, DSH_RPC_TOKEN: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const replies = new Map();
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        const resolve = replies.get(message.id);
        replies.delete(message.id);
        resolve?.(message);
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", () => {});
  const request = (id, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for MCP response ${id}`)), 5000);
    replies.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params })}\n`);
  });
  try {
    for (const [id, args, expected] of [
      [1, {}, /`approval_id` is required/],
      [2, { approval_id: "approval-x", decision: "maybe" }, /decision.*allow-once.*reject/],
    ]) {
      const response = await request(id, { name: "dsh_approvals_resolve", arguments: args });
      assert.equal(response.result?.isError, true);
      assert.match(response.result?.content?.[0]?.text ?? "", expected);
    }
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
});
