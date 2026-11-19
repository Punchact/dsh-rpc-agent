#!/usr/bin/env node
// Verify parity between source entries and built `dist/` entries:
//   1. `index.mjs` named exports (`Object.keys(await import(...)).sort()`) match `dist/index.mjs`.
//   2. `bin/dsh-rpc.mjs` & `bin/dsh-rpc-mcp.mjs` first-line shebangs match `dist/`.
//   3. `package.json` `exports` subpaths (`.`, `./package.json`, `./client`, `./http-client`,
//      `./locale/*.json`, `./icon`) resolve to the exact same relative files inside `dist/`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dirname, "..");
const DIST = resolve(REPO, "dist");

const problems = [];
let checkedItems = 0;

if (!existsSync(DIST) || !existsSync(join(DIST, "package.json"))) {
  console.error("check-entry-parity: dist/ 或 dist/package.json 不存在，请先运行 npm run build");
  process.exit(1);
}

function firstLine(absPath) {
  return readFileSync(absPath, "utf8").split(/\r?\n/, 1)[0];
}

function toPosixRel(root, absPath) {
  return relative(root, absPath).split("\\").join("/");
}

// 1. Named exports of index.mjs (and ./http-client)
// Importing a half-built dist throws (a missing module, a syntax error). That is a real
// failure of this check, but it must read like one: report the module and exit 1 instead of
// dumping a Node stack trace, otherwise CI failure reports look like a broken tool.
async function importEntry(label, absPath) {
  try {
    return await import(pathToFileURL(absPath).href);
  } catch (error) {
    console.error(`check-entry-parity: FAIL (1)`);
    console.error(`  - ${label} 无法导入（${toPosixRel(REPO, absPath)}）: ${error?.code ?? ""} ${error?.message ?? error}`);
    process.exit(1);
  }
}

const srcIndexMod = await importEntry("源码 index.mjs", join(REPO, "index.mjs"));
const distIndexMod = await importEntry("产物 index.mjs", join(DIST, "index.mjs"));
const srcIndexExports = Object.keys(srcIndexMod).sort();
const distIndexExports = Object.keys(distIndexMod).sort();
checkedItems += 1;
if (srcIndexExports.length === 0) {
  problems.push("index.mjs 没有任何具名导出");
} else if (JSON.stringify(srcIndexExports) !== JSON.stringify(distIndexExports)) {
  problems.push(
    `index.mjs 具名导出不一致: src=[${srcIndexExports.join(",")}] vs dist=[${distIndexExports.join(",")}]`,
  );
}

// 2. First-line shebang of bin/*
for (const binRel of ["bin/dsh-rpc.mjs", "bin/dsh-rpc-mcp.mjs"]) {
  checkedItems += 1;
  const srcBin = join(REPO, binRel);
  const distBin = join(DIST, binRel);
  if (!existsSync(distBin)) {
    problems.push(`缺失 bin 产物: dist/${binRel}`);
    continue;
  }
  const srcShebang = firstLine(srcBin);
  const distShebang = firstLine(distBin);
  if (!srcShebang.startsWith("#!")) {
    problems.push(`源码 ${binRel} 首行不是 shebang: ${JSON.stringify(srcShebang)}`);
  } else if (srcShebang !== distShebang) {
    problems.push(
      `${binRel} 首行 shebang 不一致: src=${JSON.stringify(srcShebang)} vs dist=${JSON.stringify(distShebang)}`,
    );
  }
}

// 3. package.json exports subpaths in src vs dist
const srcPkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const distPkg = JSON.parse(readFileSync(join(DIST, "package.json"), "utf8"));

const srcExports = srcPkg.exports ?? {};
const distExports = distPkg.exports ?? {};

for (const [subpath, srcTarget] of Object.entries(srcExports)) {
  checkedItems += 1;
  const distTarget = distExports[subpath];
  if (distTarget !== srcTarget) {
    problems.push(
      `exports["${subpath}"] 在 dist/package.json 不一致: src=${JSON.stringify(srcTarget)} vs dist=${JSON.stringify(distTarget)}`,
    );
    continue;
  }
  if (typeof srcTarget !== "string") {
    problems.push(`exports["${subpath}"] 不是字符串目标: ${JSON.stringify(srcTarget)}`);
    continue;
  }
  if (srcTarget.includes("*")) {
    // Expand wildcard pattern such as ./locale/*.json
    const relPattern = srcTarget.replace(/^\.\//, "");
    const starIdx = relPattern.indexOf("*");
    const dirRel = posix.dirname(relPattern);
    const basePattern = posix.basename(relPattern);
    const [prefix, suffix] = basePattern.split("*");
    if (starIdx < 0 || !existsSync(join(REPO, dirRel)) || !existsSync(join(DIST, dirRel))) {
      problems.push(`exports["${subpath}"] 目录缺失: ${dirRel}`);
      continue;
    }
    const matchDir = (base) =>
      readdirSync(join(base, dirRel))
        .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
        .sort();
    const srcMatches = matchDir(REPO);
    const distMatches = matchDir(DIST);
    if (srcMatches.length === 0) {
      problems.push(`exports["${subpath}"] 在源码中未匹配到任何文件`);
    } else if (JSON.stringify(srcMatches) !== JSON.stringify(distMatches)) {
      problems.push(
        `exports["${subpath}"] 通配解析结果不一致: src=[${srcMatches.join(",")}] vs dist=[${distMatches.join(",")}]`,
      );
    }
    continue;
  }

  const srcResolved = resolve(REPO, srcTarget);
  const distResolved = resolve(DIST, distTarget);
  const srcRel = toPosixRel(REPO, srcResolved);
  const distRel = toPosixRel(DIST, distResolved);
  if (!existsSync(srcResolved)) {
    problems.push(`exports["${subpath}"] 源码目标不存在: ${srcRel}`);
  } else if (!existsSync(distResolved)) {
    problems.push(`exports["${subpath}"] 产物目标不存在: dist/${distRel}`);
  } else if (srcRel !== distRel) {
    problems.push(`exports["${subpath}"] 解析路径不一致: src=${srcRel} vs dist=${distRel}`);
  }
}

// Extra check: ./http-client named exports parity
const srcHttpClient = await importEntry("源码 lib/client.mjs", join(REPO, "lib/client.mjs"));
const distHttpClient = await importEntry("产物 lib/client.mjs", join(DIST, "lib/client.mjs"));
const srcClientKeys = Object.keys(srcHttpClient).sort();
const distClientKeys = Object.keys(distHttpClient).sort();
checkedItems += 1;
if (JSON.stringify(srcClientKeys) !== JSON.stringify(distClientKeys)) {
  problems.push(
    `lib/client.mjs 具名导出不一致: src=[${srcClientKeys.join(",")}] vs dist=[${distClientKeys.join(",")}]`,
  );
}

if (problems.length > 0) {
  console.error(`check-entry-parity: FAIL (${problems.length})`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `entry-parity ok: ${checkedItems} 项比对全部通过（index 导出 ${srcIndexExports.length} 个：[${srcIndexExports.join(", ")}]；shebang 2 项；exports 子路径 ${Object.keys(srcExports).length} 项；http-client 导出 ${srcClientKeys.length} 个）`,
);
