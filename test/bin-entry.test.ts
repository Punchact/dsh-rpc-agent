// Both bins decide "am I the entry point?" by comparing process.argv[1] with
// import.meta.url. Node resolves the module URL through a symlink or Windows
// junction but leaves argv[1] as typed, so the comparison failed and the bin
// exited 0 without doing anything — a failure indistinguishable from success
// (quality review, 0.9.4 findings 3). The fix resolves both sides; these cases
// run the real bins through a junction/symlink and fail if the silence returns.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const REPO = resolve(import.meta.dirname, "..");
const DIST = join(REPO, "dist");

function makeLink() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-entry-"));
  const link = join(dir, "package");
  // "junction" on Windows, a plain directory symlink elsewhere; both reproduce
  // the resolved-vs-unresolved mismatch.
  symlinkSync(DIST, link, "junction");
  return { dir, link };
}

test("the CLI entry point works through a junction instead of exiting silently", () => {
  const { dir, link } = makeLink();
  try {
    const physical = spawnSync(process.execPath, [join(DIST, "bin", "dsh-rpc.mjs"), "--help"], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(physical.status, 0, physical.stderr);
    assert.match(physical.stdout, /USAGE/);

    const linked = spawnSync(process.execPath, [join(link, "bin", "dsh-rpc.mjs"), "--help"], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(linked.status, 0, `linked entry exited ${linked.status}: ${linked.stderr}`);
    assert.match(
      linked.stdout,
      /USAGE/,
      "the CLI printed nothing through the junction — the entry-point check regressed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the MCP entry point answers initialize through a junction", async () => {
  const { dir, link } = makeLink();
  const entry = join(link, "bin", "dsh-rpc-mcp.mjs");
  assert.ok(existsSync(entry), `junction target missing: ${entry}`);
  const child = spawn(process.execPath, [entry], {
    cwd: REPO,
    env: { ...process.env, DSH_RPC_TOKEN: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const reply = new Promise<{ id: unknown; result?: { protocolVersion?: unknown } }>((resolveReply, rejectReply) => {
    const timer = setTimeout(() => rejectReply(new Error("the MCP entry never answered initialize")), 15000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolveReply(JSON.parse(buffer.slice(0, newline)) as { id: unknown; result?: { protocolVersion?: unknown } });
    });
  });
  child.stderr.setEncoding("utf8").on("data", () => {});
  try {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "entry-test" } } })}\n`,
    );
    const message = await reply;
    assert.equal(message.id, 1);
    assert.equal(typeof message.result?.protocolVersion, "string");
  } finally {
    child.stdin.end();
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        child.kill();
        done();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
