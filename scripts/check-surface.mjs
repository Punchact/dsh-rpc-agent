// 方案接口面与代码的对账。
//
// 背景：0.9.0 是「先写方案、再照方案实现」做的，但方案里的 RPC / MCP 工具 / CLI 清单和代码之间
// 没有机器可核对的关系。真机冒烟时已经付过一次代价——`dsh.tasks.resolve` 方案里写了、实现漏了，
// 直到适配器永远给不出 `review_pending` 才暴露。这个脚本把两边接上：
//
//   docs/api-surface.json 是方案接口面的快照（方案文档 sha256 + 三类清单 + 实现侧多出来的部分）；
//   `node scripts/check-surface.mjs`        拿快照对代码，两个方向都查：
//                                           方案要求的必须存在；代码里任务/代理族的接口必须
//                                           要么在方案里，要么在快照的 implementationOnly 里。
//   `node scripts/check-surface.mjs --write` 重新从方案文档抽快照（需要本地有那份方案文档，
//                                           可用 PLAN_DOC 指定路径）。改动方案后跑一次。
//
// 快照进仓库、方案文档不进：CI 只读快照就能对账，方案留在本地。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SNAPSHOT = "docs/api-surface.json";
const DEFAULT_PLAN = resolve(REPO, "..", "DSH本机Agent任务中心实施方案-合并版v1.0-20261118.md");
const read = (rel) => readFileSync(join(REPO, rel), "utf8").replace(/\r\n/g, "\n");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// --- 代码侧的三类接口面 ---------------------------------------------------------------
function sliceBlock(source, header, footer) {
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`check-surface: 找不到 ${header}`);
  const end = footer ? source.indexOf(footer, start + header.length) : source.length;
  return source.slice(start, end < 0 ? source.length : end);
}

const methodsSource = read("lib/methods.mjs");
const catalogBlock = sliceBlock(methodsSource, "const METHOD_CATALOG = [", "\n];");
const codeRpc = [...catalogBlock.matchAll(/name:\s*"(dsh\.[a-zA-Z.]+)"/g)].map((m) => m[1]);

const mcpSource = read("bin/dsh-rpc-mcp.mjs");
const codeMcp = [
  ...sliceBlock(mcpSource, "const BASE_TOOLS = [", "\n];").matchAll(/name:\s*"(dsh_[a-z_]+)"/g),
  ...sliceBlock(mcpSource, "const TASK_TOOLS = [", "\n];").matchAll(/name:\s*"(dsh_[a-z_]+)"/g),
].map((m) => m[1]);

const cliSource = read("bin/dsh-rpc.mjs");
const tasksCli = sliceBlock(cliSource, "async function runTasksCommand", "async function runAgentsCommand");
const agentsCli = sliceBlock(cliSource, "async function runAgentsCommand", "\nasync function ");
const codeCli = [
  ...[...tasksCli.matchAll(/case "([a-z][a-z-]*)":/g)].map((m) => `tasks ${m[1]}`),
  ...[...agentsCli.matchAll(/case "([a-z][a-z-]*)":/g)].map((m) => `agents ${m[1]}`),
].sort();

const familyRpc = (n) => n.startsWith("dsh.tasks.") || n.startsWith("dsh.agents.");
const familyMcp = (n) => n.startsWith("dsh_task_") || n.startsWith("dsh_agents_");

// --- 从方案文档抽取 ---------------------------------------------------------------------
function extractFromPlan(planPath) {
  if (!existsSync(planPath)) {
    throw new Error(
      `check-surface: 找不到方案文档 ${planPath}\n` +
        "  只核对仓库快照时用 `node scripts/check-surface.mjs`；要重新抽快照才需要方案文档，或用 PLAN_DOC 指路径。",
    );
  }
  const raw = readFileSync(planPath, "utf8").replace(/\r\n/g, "\n");
  const rpc = [...new Set([...raw.matchAll(/dsh\.[a-z]+\.[a-zA-Z]+/g)].map((m) => m[0]))].sort();
  const mcpTools = [...new Set([...raw.matchAll(/\bdsh_[a-z_]+/g)].map((m) => m[0]))].sort();
  const cli = [...new Set([...raw.matchAll(/dsh-rpc (tasks|agents) ([a-z][a-z-]*)/g)].map((m) => `${m[1]} ${m[2]}`))].sort();
  return { raw, sourceSha256: sha256(raw), rpc, mcpTools, cli };
}

const mode = process.argv.includes("--write") ? "write" : "check";

if (mode === "write") {
  const planPath = process.env.PLAN_DOC ? resolve(process.env.PLAN_DOC) : DEFAULT_PLAN;
  const plan = extractFromPlan(planPath);
  // 实现侧多出来的部分：代码里有、方案里没提。写进快照，作为「知道它多出来」的凭据。
  const implementationOnly = {
    rpc: codeRpc.filter((n) => familyRpc(n) && !plan.rpc.includes(n)).sort(),
    mcpTools: codeMcp.filter((n) => familyMcp(n) && !plan.mcpTools.includes(n)).sort(),
    cli: codeCli.filter((n) => !plan.cli.includes(n)).sort(),
    note: "方案没写、实现里确实有。多数是 0.9.0 实施时补的内部操作面（dispatch/pump/reconcile 这类派发与核对入口）；CLI 多出来的是方案只写了主干五条命令。新增接口要么补进方案，要么重新抽快照让这里如实记一笔。",
  };
  const snapshot = {
    note: "方案接口面的快照。来源是本地方案文档，用 `npm run docs:surface` 重新抽取；`npm run check:surface` 拿它对代码，不需要方案文档在场。不要手改。",
    source: { path: planPath, sha256: plan.sourceSha256 },
    extractedAt: new Date().toISOString().slice(0, 10),
    rpc: plan.rpc,
    mcpTools: plan.mcpTools,
    cli: plan.cli,
    implementationOnly,
  };
  const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error("check-surface: 拒绝写入 BOM");
  writeFileSync(join(REPO, SNAPSHOT), bytes);
  console.log(
    `surface: 已写 ${SNAPSHOT} — 方案 ${plan.rpc.length} RPC / ${plan.mcpTools.length} MCP / ${plan.cli.length} CLI，` +
      `实现侧多出 ${implementationOnly.rpc.length} RPC / ${implementationOnly.mcpTools.length} MCP / ${implementationOnly.cli.length} CLI`,
  );
  process.exit(0);
}

// --- 核对 ---------------------------------------------------------------------------------
const snapshot = JSON.parse(read(SNAPSHOT));
const problems = [];

for (const name of snapshot.rpc) {
  if (!codeRpc.includes(name)) problems.push(`方案要求 RPC ${name}，但 METHOD_CATALOG 里没有`);
}
for (const name of snapshot.mcpTools) {
  if (!codeMcp.includes(name)) problems.push(`方案要求 MCP 工具 ${name}，但 bin/dsh-rpc-mcp.mjs 里没有`);
}
for (const pair of snapshot.cli) {
  if (!codeCli.includes(pair)) problems.push(`方案要求 CLI \`dsh-rpc ${pair}\`，但 bin/dsh-rpc.mjs 里没有`);
}

const declaredRpc = new Set([...snapshot.rpc, ...snapshot.implementationOnly.rpc]);
for (const name of codeRpc.filter(familyRpc)) {
  if (!declaredRpc.has(name)) problems.push(`代码新增 RPC ${name} 既不在方案里，也不在快照 implementationOnly 里 — 补方案或跑 npm run docs:surface`);
}
const declaredMcp = new Set([...snapshot.mcpTools, ...snapshot.implementationOnly.mcpTools]);
for (const name of codeMcp.filter(familyMcp)) {
  if (!declaredMcp.has(name)) problems.push(`代码新增 MCP 工具 ${name} 未在方案或 implementationOnly 里声明`);
}
const declaredCli = new Set([...snapshot.cli, ...snapshot.implementationOnly.cli]);
for (const pair of codeCli) {
  if (!declaredCli.has(pair)) problems.push(`代码新增 CLI \`dsh-rpc ${pair}\` 未在方案或 implementationOnly 里声明`);
}

// 快照自己也要跟方案文档对得上：本机有方案文档时顺便校验 sha256，防止快照悄悄过期。
const planPath = process.env.PLAN_DOC ? resolve(process.env.PLAN_DOC) : snapshot.source.path;
if (existsSync(planPath)) {
  const current = sha256(readFileSync(planPath, "utf8").replace(/\r\n/g, "\n"));
  if (current !== snapshot.source.sha256) {
    console.log(`surface: 注意 — 方案文档已变（sha256 ${current.slice(0, 12)} != ${snapshot.source.sha256.slice(0, 12)}），快照可能过期，跑 npm run docs:surface 重抽`);
  }
}

if (problems.length) {
  console.error(`check-surface: ${problems.length} 处方案与代码接口面不一致：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `surface ok: 方案 ${snapshot.rpc.length} RPC / ${snapshot.mcpTools.length} MCP / ${snapshot.cli.length} CLI 全部存在；` +
    `实现侧多出 ${snapshot.implementationOnly.rpc.length} RPC / ${snapshot.implementationOnly.mcpTools.length} MCP / ${snapshot.implementationOnly.cli.length} CLI 已声明`,
);
