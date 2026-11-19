// 文档数字的单源校验与同步。
//
// 背景：0.9.0 那几轮里，测试例数与方法数在 README / README.en / CHANGELOG 三处被手工抄来抄去，
// 一共改了七次（346→348→349→366→369→372→373→375），每次都靠一次性补丁脚本。这个脚本把
// 「数字从哪来」定死：
//
//   - 能从代码或磁盘算出来的（RPC 方法数、MCP 工具数、`npm test` 链上的测试文件数）一律现算；
//   - 算不出来的（用例总数要整跑一遍才知道）记在 `docs/counts.json` 里，作为唯一来源。
//
// `node scripts/check-docs.mjs`        核对：文档里的数字必须与上面两处一致，不一致就失败。
// `node scripts/check-docs.mjs --write` 同步：把这些数字刷进文档（幂等，再跑一次不会有改动）。
//
// 匹配用的锚点是固定的；锚点消失也算失败——那样说明这句文档被改写，规则该跟着更新，而不是静默放过。
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => readFileSync(join(REPO, rel), "utf8").replace(/\r\n/g, "\n");

// --- 单源数字 ---------------------------------------------------------------------------
const methodsSource = read("lib/methods.mjs");
const rpcNames = [...methodsSource.matchAll(/name:\s*"(dsh\.[a-zA-Z.]+)"/g)].map((m) => m[1]);
const rpcTotal = rpcNames.length;
if (rpcTotal === 0) throw new Error("check-docs: no RPC method names found in lib/methods.mjs");

const mcpSource = read("bin/dsh-rpc-mcp.mjs");
const sliceTable = (constName) => {
  const start = mcpSource.indexOf(`const ${constName} = [`);
  if (start < 0) throw new Error(`check-docs: ${constName} not found in bin/dsh-rpc-mcp.mjs`);
  const end = mcpSource.indexOf("\n];", start);
  return mcpSource.slice(start, end < 0 ? undefined : end);
};
const baseTools = [...sliceTable("BASE_TOOLS").matchAll(/name:\s*"(dsh_[a-z_]+)"/g)].map((m) => m[1]);
const taskTools = [...sliceTable("TASK_TOOLS").matchAll(/name:\s*"(dsh_[a-z_]+)"/g)].map((m) => m[1]);
const taskOnly = taskTools.filter((n) => n.startsWith("dsh_task_"));
const agentOnly = taskTools.filter((n) => n.startsWith("dsh_agents_"));
const mcpBase = baseTools.length;
const mcpTask = taskOnly.length;
const mcpAgent = agentOnly.length;
const mcpTotal = mcpBase + mcpTask + mcpAgent;

const pkg = JSON.parse(read("package.json"));
const chain = pkg.scripts.test.split("&&").map((s) => s.trim());
const testChainFiles = chain.filter((s) => /^node test\/.+\.test\.mjs$/.test(s)).length;
const testOnDisk = readdirSync(join(REPO, "test")).filter((f) => f.endsWith(".test.mjs")).length;

const countsPath = "docs/counts.json";
const counts = JSON.parse(read(countsPath));
const testCases = counts.testCases;

const expected = {
  rpcTotal,
  mcpBase,
  mcpTask,
  mcpAgent,
  mcpTotal,
  testFiles: testChainFiles,
  testCases,
};

// --- 锚点规则 ---------------------------------------------------------------------------
// 每条规则：文件、正则（必须带命名组）、每组对应的期望值。`onlyLatest` 表示只作用于
// CHANGELOG 最新一节（历史章节的数字是当时的事实，不该被后来的改动覆盖）。
const rules = [
  { file: "README.md", onlyLatest: false, re: /(?<files>\d+) 个测试文件共 (?<cases>\d+) 例/g, expect: (m) => ({ files: expected.testFiles, cases: expected.testCases }) },
  { file: "README.md", onlyLatest: false, re: /本机实测 (?<pass>\d+)\/(?<total>\d+) 通过/g, expect: () => ({ pass: expected.testCases, total: expected.testCases }) },
  { file: "README.md", onlyLatest: false, re: /共 \*\*(?<n>\d+) 个\*\* JSON-RPC 方法/g, expect: () => ({ n: expected.rpcTotal }) },
  { file: "README.md", onlyLatest: false, re: /默认暴露 \*\*(?<base>\d+) 个工具\*\*/g, expect: () => ({ base: expected.mcpBase }) },
  { file: "README.md", onlyLatest: false, re: /额外挂载 \*\*(?<task>\d+) 个\*\*任务工具/g, expect: () => ({ task: expected.mcpTask }) },
  { file: "README.md", onlyLatest: false, re: /与 \*\*(?<agent>\d+) 个\*\*代理工具/g, expect: () => ({ agent: expected.mcpAgent }) },
  { file: "README.md", onlyLatest: false, re: /，共 \*\*(?<total>\d+) 个\*\*）：/g, expect: () => ({ total: expected.mcpTotal }) },
  { file: "README.md", onlyLatest: false, re: /# (?<files>\d+) 个测试文件，共 (?<cases>\d+) 例/g, expect: () => ({ files: expected.testFiles, cases: expected.testCases }) },
  { file: "README.md", onlyLatest: false, re: /链上 (?<files>\d+) 个测试文件 \*\*(?<pass>\d+)\/(?<total>\d+)\*\*/g, expect: () => ({ files: expected.testFiles, pass: expected.testCases, total: expected.testCases }) },
  { file: "README.md", onlyLatest: false, re: /`methods: (?<n>\d+)`/g, expect: () => ({ n: expected.rpcTotal }) },

  { file: "README.en.md", onlyLatest: false, re: /(?<files>\d+) test files \((?<cases>\d+) cases\)/g, expect: () => ({ files: expected.testFiles, cases: expected.testCases }) },
  { file: "README.en.md", onlyLatest: false, re: /\((?<pass>\d+)\/(?<total>\d+) pass locally/g, expect: () => ({ pass: expected.testCases, total: expected.testCases }) },
  { file: "README.en.md", onlyLatest: false, re: /\*\*(?<base>\d+) tools\*\* are exposed by default/g, expect: () => ({ base: expected.mcpBase }) },
  { file: "README.en.md", onlyLatest: false, re: /\*\*(?<task>\d+)\*\* additional task tools/g, expect: () => ({ task: expected.mcpTask }) },
  { file: "README.en.md", onlyLatest: false, re: /\*\*(?<agent>\d+)\*\* agent tools/g, expect: () => ({ agent: expected.mcpAgent }) },
  { file: "README.en.md", onlyLatest: false, re: /\*\*(?<total>\d+)\*\* total\)/g, expect: () => ({ total: expected.mcpTotal }) },
  { file: "README.en.md", onlyLatest: false, re: /# (?<files>\d+) test files, (?<cases>\d+) cases/g, expect: () => ({ files: expected.testFiles, cases: expected.testCases }) },
  { file: "README.en.md", onlyLatest: false, re: /all (?<files>\d+) test files in the `npm test` chain pass \(\*\*(?<pass>\d+)\/(?<total>\d+)\*\* cases/g, expect: () => ({ files: expected.testFiles, pass: expected.testCases, total: expected.testCases }) },
  { file: "README.en.md", onlyLatest: false, re: /`methods: (?<n>\d+)`/g, expect: () => ({ n: expected.rpcTotal }) },

  { file: "README.md", onlyLatest: false, re: /(?<files>\d+) 个测试文件各自覆盖什么/g, expect: () => ({ files: expected.testFiles }) },
  { file: "README.en.md", onlyLatest: false, re: /What each of the (?<files>\d+) test files covers/g, expect: () => ({ files: expected.testFiles }) },

  { file: "CHANGELOG.md", onlyLatest: true, re: /方法总数 \*\*17 → (?<n>\d+)\*\*/g, expect: () => ({ n: expected.rpcTotal }) },
  { file: "CHANGELOG.md", onlyLatest: true, re: /\*\*11（默认）\+ (?<task>\d+)（`tasksEnabled: true` 时共 (?<total>\d+) 个）\*\*/g, expect: () => ({ task: expected.mcpTotal - expected.mcpBase, total: expected.mcpTotal }) },
  { file: "CHANGELOG.md", onlyLatest: true, re: /全链 (?<files>\d+) 个测试文件、\*{0,2}(?<cases>\d+) 例/g, expect: () => ({ files: expected.testFiles, cases: expected.testCases }) },
  { file: "CHANGELOG.md", onlyLatest: true, re: /校验 (?<n>\d+) 个 RPC 方法/g, expect: () => ({ n: expected.rpcTotal }) },
];

// CHANGELOG 最新一节 = 第一个 `## [` 到第二个 `## [` 之间。
function latestChangelogSlice(text) {
  const first = text.indexOf("\n## [");
  if (first < 0) throw new Error("check-docs: no versioned section in CHANGELOG.md");
  const next = text.indexOf("\n## [", first + 1);
  return { start: first, end: next < 0 ? text.length : next };
}

const files = new Map();
for (const rel of new Set(rules.map((r) => r.file))) files.set(rel, read(rel));

const mode = process.argv.includes("--write") ? "write" : "check";
const problems = [];
const rewrites = [];

for (const rule of rules) {
  const text = files.get(rule.file);
  const scope = rule.onlyLatest ? latestChangelogSlice(text) : { start: 0, end: text.length };
  const body = text.slice(scope.start, scope.end);
  const matches = [...body.matchAll(rule.re)];
  if (matches.length === 0) {
    problems.push(`${rule.file}: 找不到锚点 ${rule.re} — 这句文档被改写了，请同步更新 scripts/check-docs.mjs 的规则`);
    continue;
  }
  for (const m of matches) {
    const want = rule.expect(m);
    const got = Object.fromEntries(Object.keys(want).map((k) => [k, m.groups[k]]));
    const diffs = Object.keys(want).filter((k) => String(want[k]) !== String(got[k]));
    if (diffs.length === 0) continue;
    const line = text.slice(0, scope.start).split("\n").length + body.slice(0, m.index).split("\n").length - 1;
    problems.push(
      `${rule.file}:${line}: ${diffs.map((k) => `${k} 文档=${got[k]} 应为=${want[k]}`).join("，")} — 「${m[0].slice(0, 60)}」`,
    );
    if (mode === "write") {
      let replacement = m[0];
      for (const k of diffs) replacement = replacement.replace(m.groups[k], String(want[k]));
      rewrites.push({ file: rule.file, absoluteStart: scope.start + m.index, length: m[0].length, replacement });
    }
  }
}

if (mode === "check") {
  if (problems.length) {
    console.error(`check-docs: ${problems.length} 处文档数字与源码/计数不符：`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\n跑 `npm run docs:counts` 可以把这些数字刷成当前值；如果用例数本身变了，先改 docs/counts.json。");
    process.exit(1);
  }
  console.log(
    `docs ok: RPC ${rpcTotal} / MCP ${mcpBase}+${mcpTask}+${mcpAgent}=${mcpTotal} / 测试文件 ${testChainFiles}（磁盘 ${testOnDisk}）/ 用例 ${testCases}`,
  );
  process.exit(0);
}

// --write：从后往前替换，避免偏移失效；同一文件多处改动一次性写回。
if (rewrites.length === 0) {
  console.log("docs:counts — 已经是当前值，没有需要写的地方");
  process.exit(0);
}
const byFile = new Map();
for (const r of rewrites) {
  if (!byFile.has(r.file)) byFile.set(r.file, []);
  byFile.get(r.file).push(r);
}
for (const [rel, list] of byFile) {
  let text = files.get(rel);
  for (const r of list.sort((a, b) => b.absoluteStart - a.absoluteStart)) {
    text = text.slice(0, r.absoluteStart) + r.replacement + text.slice(r.absoluteStart + r.length);
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error(`${rel}: 拒绝写入 BOM`);
  writeFileSync(join(REPO, rel), bytes);
  console.log(`wrote ${relative(REPO, join(REPO, rel))}: ${list.length} 处`);
}
console.log(`docs:counts — 已同步 ${rewrites.length} 处；再跑一次 check 确认幂等`);
