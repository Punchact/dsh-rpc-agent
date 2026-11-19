#!/usr/bin/env node
// Verify parity between source entries and built `dist/` entries:
//   1. `index.mjs` named exports (`Object.keys(await import(...)).sort()`) match `dist/index.mjs`.
//   2. `bin/dsh-rpc.mjs` & `bin/dsh-rpc-mcp.mjs` first-line shebangs match `dist/`.
//   3. `package.json` `exports` subpaths (`.`, `./package.json`, `./client`, `./http-client`,
//      `./locale/*.json`, `./icon`) resolve to the exact same relative files inside `dist/`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

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

// Once any transitive dependency moves to `src/**/*.mts` and its old `.mjs` is deleted,
// unbuilt source entries in REPO can no longer be dynamically `import()`ed at runtime.
// Parse the source entry's exported runtime names via TypeScript AST and compare against
// the live `import()` of the built `dist/` entry.
function resolveSourceEntryPath(relMjsPath) {
  const direct = join(REPO, relMjsPath);
  if (existsSync(direct)) return direct;
  if (relMjsPath.endsWith(".mjs")) {
    const mts = join(REPO, "src", relMjsPath.replace(/\.mjs$/, ".mts"));
    if (existsSync(mts)) return mts;
  }
  return null;
}

function collectBindingNames(nameNode, out) {
  if (ts.isIdentifier(nameNode)) {
    out.push(nameNode.text);
  } else if (ts.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.elements) collectBindingNames(el.name, out);
  } else if (ts.isArrayBindingPattern(nameNode)) {
    for (const el of nameNode.elements) {
      if (ts.isBindingElement(el)) collectBindingNames(el.name, out);
    }
  }
}

function extractSourceExports(label, relMjsPath) {
  const absPath = resolveSourceEntryPath(relMjsPath);
  if (!absPath) {
    console.error(`check-entry-parity: FAIL (1)`);
    console.error(`  - ${label} 源文件不存在（${relMjsPath}）`);
    process.exit(1);
  }
  const text = readFileSync(absPath, "utf8");
  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true);
  const names = new Set();
  for (const stmt of sf.statements) {
    const hasExport = Boolean(stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    const hasDefault = Boolean(stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
    if (hasExport) {
      if (hasDefault) names.add("default");
      if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
        if (stmt.name) names.add(stmt.name.text);
      } else if (ts.isVariableStatement(stmt)) {
        const extracted = [];
        for (const decl of stmt.declarationList.declarations) {
          collectBindingNames(decl.name, extracted);
        }
        for (const n of extracted) names.add(n);
      }
    } else if (ts.isExportAssignment(stmt)) {
      if (!stmt.isExportEquals) names.add("default");
    } else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          if (!spec.isTypeOnly) names.add(spec.name.text);
        }
      }
    }
  }
  return [...names].sort();
}

const srcIndexExports = extractSourceExports("源码 index.mjs", "index.mjs");
const distIndexMod = await importEntry("产物 index.mjs", join(DIST, "index.mjs"));
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
  const srcBin = resolveSourceEntryPath(binRel);
  const distBin = join(DIST, binRel);
  if (!srcBin) {
    problems.push(`缺失 bin 源码: ${binRel}`);
    continue;
  }
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

  const srcRel = srcTarget.replace(/^\.\//, "");
  const srcResolved = resolveSourceEntryPath(srcRel);
  const distResolved = resolve(DIST, srcTarget);
  const distRel = toPosixRel(DIST, distResolved);
  if (!srcResolved) {
    problems.push(`exports["${subpath}"] 源码目标不存在: ${srcRel}`);
  } else if (!existsSync(distResolved)) {
    problems.push(`exports["${subpath}"] 产物目标不存在: dist/${distRel}`);
  } else if (srcRel !== distRel) {
    problems.push(`exports["${subpath}"] 解析路径不一致: src=${srcRel} vs dist=${distRel}`);
  }
}

// Extra check: ./http-client named exports parity
const srcClientKeys = extractSourceExports("源码 lib/client.mjs", "lib/client.mjs");
const distHttpClient = await importEntry("产物 lib/client.mjs", join(DIST, "lib/client.mjs"));
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
