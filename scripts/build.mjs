#!/usr/bin/env node
// Assemble `dist/` as a complete, publishable package directory:
//   1. Clean `dist/`.
//   2. Compile `src/**/*.mts` -> `dist/**/*.mjs` via tsc (0 files in PR 1a is valid).
//   3. Byte-for-byte copy all unmigrated files.
//   4. Emit `dist/package.json` matching root `package.json`.
//   5. Assert SHA-256 byte fidelity and total file count (58).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectMigratedOutputs,
  collectUnmigratedFiles,
  verifyDistFidelity,
} from "./check-dist-fidelity.mjs";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(REPO, "dist");
const EXPECTED_DIST_FILES = 58;

// 1. Clean dist/
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// 2. Compile src/**/*.mts -> dist/
const { tsFiles, outSet } = collectMigratedOutputs(REPO);
if (tsFiles.length > 0) {
  const tscBin = join(REPO, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tscBin)) {
    console.error("build: 未找到 node_modules/typescript/bin/tsc，请先运行 npm install");
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [tscBin, "-p", join(REPO, "tsconfig.json")], {
    cwd: REPO,
    stdio: "inherit",
  });
  if (res.error) {
    console.error(`build: 执行 tsc 失败: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`build: tsc 编译失败 (exit=${res.status})`);
    process.exit(res.status ?? 1);
  }
}

// 3. Copy unmigrated files byte-for-byte
const unmigrated = collectUnmigratedFiles(REPO);
for (const rel of unmigrated) {
  if (outSet.has(rel)) {
    console.error(`build: 冲突 — ${rel} 同时存在于未迁移源码与 src/**/*.mts 编译产物`);
    process.exit(1);
  }
  const srcPath = join(REPO, rel);
  const destPath = join(DIST, rel);
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
}

// 4. Write dist/package.json (identical content to root package.json)
const pkgBytes = readFileSync(join(REPO, "package.json"));
writeFileSync(join(DIST, "package.json"), pkgBytes);

// 5. Assert byte-for-byte SHA-256 fidelity and exact file count
const check = verifyDistFidelity({
  repoRoot: REPO,
  distRoot: DIST,
  expectedCount: EXPECTED_DIST_FILES,
});
if (!check.ok) {
  console.error(`build: 校验失败 (${check.problems.length})`);
  for (const p of check.problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `build: 编译 ${tsFiles.length} 个 .mts，复制文件数 = ${unmigrated.length}，生成 dist/package.json`,
);
console.log(`build: 保真断言通过，dist 文件数 = ${check.distCount}`);
