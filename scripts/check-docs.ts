// 文档数字的单源校验与同步。
//
// 背景：0.9.0 那几轮里，测试例数与方法数在 README / README.en / CHANGELOG 三处被手工抄来抄去，
// 一共改了七次（346→348→349→366→369→372→373→375），每次都靠一次性补丁脚本。这个脚本把
// 「数字从哪来」定死：
//
//   - 能从代码或磁盘算出来的（RPC 方法数、MCP 工具数、`npm test` 链上的测试文件数）一律现算；
//   - 算不出来的（用例总数要整跑一遍才知道）记在 `docs/counts.json` 里，作为唯一来源。
//
// `node scripts/check-docs.ts`         核对：文档里的数字必须与上面两处一致，不一致就失败。
// `node scripts/check-docs.mjs --write` 同步：把这些数字刷进文档（幂等，再跑一次不会有改动）。
//
// 匹配用的锚点是固定的；锚点消失也算失败——那样说明这句文档被改写，规则该跟着更新，而不是静默放过。
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chainDigest } from "./count-cases.ts";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => readFileSync(join(REPO, rel), "utf8").replace(/\r\n/g, "\n");
const readDist = (rel) => {
  const full = join(REPO, "dist", rel);
  if (!existsSync(full)) {
    console.error(`check-docs: 找不到产物文件 dist/${rel} — 请先运行 \`npm run build\``);
    process.exit(1);
  }
  return readFileSync(full, "utf8").replace(/\r\n/g, "\n");
};

// --- 单源数字（代码侧锚点一律扫 dist/ 产物） ----------------------------------------------
const methodsSource = readDist("lib/methods.mjs");
const rpcNames = [...methodsSource.matchAll(/name:\s*"(dsh\.[a-zA-Z.]+)"/g)].map((m) => m[1]);
const rpcTotal = rpcNames.length;
if (rpcTotal === 0) throw new Error("check-docs: no RPC method names found in dist/lib/methods.mjs");

const mcpSource = readDist("bin/dsh-rpc-mcp.mjs");
const sliceTable = (constName) => {
  const start = mcpSource.indexOf(`const ${constName} = [`);
  if (start < 0) throw new Error(`check-docs: ${constName} not found in dist/bin/dsh-rpc-mcp.mjs`);
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

const pkg = JSON.parse(readDist("package.json"));
const chain = pkg.scripts.test.split("&&").map((s) => s.trim());
const testChainFiles = chain.filter((s) => /^node test\/.+\.test\.mjs$/.test(s)).length;
const testOnDisk = readdirSync(join(REPO, "test")).filter((f) => f.endsWith(".test.mjs")).length;

const countsPath = "docs/counts.json";
const counts = JSON.parse(read(countsPath));

// 0.9.2（复核 NOTES）：这个数以前是手填的，`--write` 会把写错的值当正确答案刷进文档——手填的数字
// 没有任何东西能证明它是真的。现在它只能由 `scripts/count-cases.mjs` 真跑一遍后写入，并附带测试
// 文件摘要与声明条数；这里重算一遍，对不上就说明「文件变了、数字没重算」或者「有人直接改了数字」。
const chainMeta = chainDigest();
const staleReasons = [];
if (counts.testChainDigest !== chainMeta.digest) staleReasons.push("测试文件内容与记录不符");
if (counts.declaredCases !== chainMeta.declared) staleReasons.push(`声明条数 记录=${counts.declaredCases} 现在=${chainMeta.declared}`);
if (counts.testFiles !== chainMeta.files) staleReasons.push(`测试文件数 记录=${counts.testFiles} 现在=${chainMeta.files}`);
if (staleReasons.length > 0) {
  console.error(`docs: ${countsPath} 不是刚量的（${staleReasons.join("；")}）`);
  console.error("先跑 `npm run count:cases` 真量一遍，再跑 `npm run docs:counts` 把数字刷进文档。");
  process.exit(1);
}
// 反向也挡一道：跑出来的用例数不可能少于源码里声明的条数。手把数字往小改（比如为了少刷几处）会被这里拦下。
if (!Number.isInteger(counts.testCases) || counts.testCases < chainMeta.declared) {
  console.error(`docs: ${countsPath} 的用例数 ${counts.testCases} 少于声明条数 ${chainMeta.declared}，不可信`);
  console.error("跑 `npm run count:cases` 重新测量。");
  process.exit(1);
}
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
  { file: "README.md", onlyLatest: false, re: /跑这 (?<files>\d+) 个测试文件/g, expect: () => ({ files: expected.testFiles }) },
  { file: "README.en.md", onlyLatest: false, re: /runs these (?<files>\d+) test files/g, expect: () => ({ files: expected.testFiles }) },
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

  { file: "CHANGELOG.md", onlyLatest: false, re: /方法总数 \*\*17 → (?<n>\d+)\*\*/g, expect: () => ({ n: expected.rpcTotal }) },
  { file: "CHANGELOG.md", onlyLatest: false, re: /\*\*11（默认）\+ (?<task>\d+)（`tasksEnabled: true` 时共 (?<total>\d+) 个）\*\*/g, expect: () => ({ task: expected.mcpTotal - expected.mcpBase, total: expected.mcpTotal }) },
  { file: "CHANGELOG.md", onlyLatest: true, re: /全链 (?<files>\d+) 个测试文件、\*{0,2}(?<cases>\d+) 例/g, expect: () => ({ files: expected.testFiles, cases: expected.testCases }) },
  // 这一对在本轮复校里被漏掉过：`例` 被刷成新值，「本机 x/y 通过」却留在旧值上。
  { file: "CHANGELOG.md", onlyLatest: true, re: /本机 (?<pass>\d+)\/(?<total>\d+) 通过/g, expect: () => ({ pass: expected.testCases, total: expected.testCases }) },
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

// --- 测试表明细：标题说几个文件，表里就得有几行 -------------------------------------------
// 0.9.2 复核指出来的半同步：只校验标题里的数字、不校验明细表行数，会出现「标题 46、表里 45 行」。
const suiteTables = [
  { file: "README.md", header: /<summary>(\d+) 个测试文件各自覆盖什么<\/summary>/ },
  { file: "README.en.md", header: /What each of the (\d+) test files covers/ },
];
for (const table of suiteTables) {
  const text = read(table.file);
  const headerMatch = table.header.exec(text);
  if (!headerMatch) {
    problems.push(`${table.file}: 找不到测试表标题（${table.header}）— 标题被改写了，请同步更新 scripts/check-docs.mjs`);
    continue;
  }
  const startIdx = headerMatch.index + headerMatch[0].length;
  const closeIdx = text.indexOf("</details>", startIdx);
  if (closeIdx < 0) {
    // 缺闭合标签时不能"扫到文件尾"了事：下面若还有同构表格，行数会静默失真。
    problems.push(`${table.file}: 测试表缺少 </details> 闭合标签 — 修好标签再谈行数`);
    continue;
  }
  const body = text.slice(startIdx, closeIdx);
  const rows = body.split("\n").filter((line) => /^\| `[a-z0-9-]+` \| \d+ \|/.test(line)).length;
  if (rows !== expected.testFiles) {
    const line = text.slice(0, startIdx).split("\n").length;
    problems.push(`${table.file}:${line}: 测试表 ${rows} 行，链上有 ${expected.testFiles} 个测试文件 — 明细表也要跟着补/删`);
  }
}

if (mode === "check") {
  if (problems.length) {
    console.error(`check-docs: ${problems.length} 处文档数字与源码/计数不符：`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\n跑 `npm run docs:counts` 可以把这些数字刷成当前值；如果用例数本身变了，先跑 `npm run count:cases`（真跑一遍）再刷。");
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
