#!/usr/bin/env node
// Assert byte-for-byte SHA-256 fidelity of all unmigrated files in `dist/`
// against their sources, plus exact packable file count (58) and no `node_modules`.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXPECTED_DIST_FILES = 58;

const ROOT_FILES = [
  "index.mjs",
  "client.js",
  "icon.svg",
  "cordis.patch.yml",
  "README.md",
  "README.en.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "LICENSE",
];

function walkDir(absDir, relPrefix = "", filter = null) {
  if (!existsSync(absDir)) return [];
  const results = [];
  const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const rel = relPrefix ? posix.join(relPrefix, entry.name) : entry.name;
    const full = join(absDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full, rel, filter));
    } else if (entry.isFile()) {
      if (!filter || filter(rel)) results.push(rel);
    }
  }
  return results;
}

export function sha256File(absPath) {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

export function collectMigratedOutputs(repoRoot) {
  const srcRoot = join(repoRoot, "src");
  const tsFiles = walkDir(srcRoot, "", (rel) => rel.endsWith(".mts"));
  const outSet = new Set(tsFiles.map((rel) => rel.replace(/\.mts$/, ".mjs")));
  return { tsFiles, outSet };
}

export function collectUnmigratedFiles(repoRoot) {
  const files = [];
  for (const rel of ROOT_FILES) {
    if (existsSync(join(repoRoot, rel))) files.push(rel);
  }
  files.push(...walkDir(join(repoRoot, "bin"), "bin"));
  files.push(...walkDir(join(repoRoot, "lib"), "lib", (rel) => rel.endsWith(".mjs")));
  files.push(...walkDir(join(repoRoot, "locale"), "locale"));
  files.push(...walkDir(join(repoRoot, "docs"), "docs"));
  return files.sort();
}

export function verifyDistFidelity({
  repoRoot = REPO,
  distRoot = join(repoRoot, "dist"),
  expectedCount = EXPECTED_DIST_FILES,
} = {}) {
  const problems = [];
  if (!existsSync(distRoot)) {
    return {
      ok: false,
      copiedCount: 0,
      distCount: 0,
      problems: [`dist/ 目录不存在: ${distRoot}`],
    };
  }
  if (existsSync(join(distRoot, "node_modules"))) {
    problems.push("dist/node_modules 不允许存在");
  }

  const { outSet } = collectMigratedOutputs(repoRoot);
  const unmigrated = collectUnmigratedFiles(repoRoot);

  for (const rel of unmigrated) {
    if (outSet.has(rel)) {
      problems.push(`迁移冲突: ${rel} 同时存在于源码与 src/**/*.mts 产物中`);
      continue;
    }
    const srcPath = join(repoRoot, rel);
    const distPath = join(distRoot, rel);
    if (!existsSync(distPath)) {
      problems.push(`缺失产物文件: dist/${rel}`);
      continue;
    }
    const srcHash = sha256File(srcPath);
    const distHash = sha256File(distPath);
    if (srcHash !== distHash) {
      problems.push(`字节不一致: ${rel} (src=${srcHash.slice(0, 12)} != dist=${distHash.slice(0, 12)})`);
    }
  }

  const rootPkgPath = join(repoRoot, "package.json");
  const distPkgPath = join(distRoot, "package.json");
  if (!existsSync(distPkgPath)) {
    problems.push("缺失产物文件: dist/package.json");
  } else {
    const srcPkgHash = sha256File(rootPkgPath);
    const distPkgHash = sha256File(distPkgPath);
    if (srcPkgHash !== distPkgHash) {
      problems.push(
        `package.json 不一致 (src=${srcPkgHash.slice(0, 12)} != dist=${distPkgHash.slice(0, 12)})`,
      );
    }
  }

  const distFiles = walkDir(distRoot, "", (rel) => !rel.startsWith("node_modules/"));
  if (distFiles.length !== expectedCount) {
    problems.push(`dist 文件数不匹配: 实际=${distFiles.length}，期望=${expectedCount}`);
  }

  return {
    ok: problems.length === 0,
    copiedCount: unmigrated.length,
    distCount: distFiles.length,
    problems,
  };
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const result = verifyDistFidelity();
  if (!result.ok) {
    console.error(`check-dist-fidelity: FAIL (${result.problems.length})`);
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `保真断言通过（复制文件 ${result.copiedCount} + package.json），dist 文件数 = ${result.distCount}`,
  );
}
