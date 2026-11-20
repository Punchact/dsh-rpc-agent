#!/usr/bin/env node
// Assert byte-for-byte SHA-256 fidelity of all unmigrated files in `dist/`
// against their sources, plus exact packable file count (58) and no `node_modules`.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXPECTED_DIST_FILES } from "./publish-manifest.ts";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));

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

export interface PackageManifest {
  private?: boolean;
  main?: string;
  exports?: Record<string, unknown>;
  bin?: Record<string, unknown>;
  files?: string[];
  scripts?: Record<string, unknown>;
  [key: string]: unknown;
}

interface StripDistPrefixOptions {
  keepDotSlash?: boolean;
}

export interface MigratedOutputs {
  tsFiles: string[];
  outSet: Set<string>;
}

export interface VerifyDistFidelityOptions {
  repoRoot?: string;
  distRoot?: string;
  expectedCount?: number;
}

export interface VerifyDistFidelityResult {
  ok: boolean;
  copiedCount: number;
  distCount: number;
  problems: string[];
}

export const DIST_PUBLISH_FILES = [
  "index.mjs",
  "client.js",
  "lib/",
  "bin/",
  "locale/",
  "icon.svg",
  "cordis.patch.yml",
  "README.md",
  "README.en.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "LICENSE",
  "docs/",
];

function stripDistPrefix(target: string, options?: StripDistPrefixOptions): string;
function stripDistPrefix(target: unknown, options?: StripDistPrefixOptions): unknown;
function stripDistPrefix(target: unknown, { keepDotSlash = true }: StripDistPrefixOptions = {}): unknown {
  if (typeof target !== "string") return target;
  const cleaned = target.replace(/^\.\/dist\//, "./").replace(/^dist\//, "");
  if (!keepDotSlash) return cleaned.replace(/^\.\//, "");
  return cleaned;
}

/**
 * Derive the publishable `dist/package.json` manifest from the root workspace manifest:
 * removes `private: true`, rewrites `./dist/` entry targets to package-root paths, sets
 * `files`, and drops `prepublishOnly` (dist/ has no repo-only `scripts/` or `test/`).
 */
export function buildDistManifest(rootPkg: PackageManifest): PackageManifest {
  const distPkg: PackageManifest = structuredClone(rootPkg);
  delete distPkg.private;
  if (typeof distPkg.main === "string") {
    distPkg.main = stripDistPrefix(distPkg.main, { keepDotSlash: false });
  }
  if (distPkg.exports && typeof distPkg.exports === "object") {
    const nextExports: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(distPkg.exports)) {
      nextExports[k] = stripDistPrefix(v);
    }
    distPkg.exports = nextExports;
  }
  if (distPkg.bin && typeof distPkg.bin === "object") {
    const nextBin: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(distPkg.bin)) {
      nextBin[k] = stripDistPrefix(v);
    }
    distPkg.bin = nextBin;
  }
  distPkg.files = [...DIST_PUBLISH_FILES];
  if (distPkg.scripts && typeof distPkg.scripts === "object") {
    const nextScripts = { ...distPkg.scripts };
    delete nextScripts.prepublishOnly;
    distPkg.scripts = nextScripts;
  }
  return distPkg;
}

function walkDir(absDir: string, relPrefix = "", filter: ((rel: string) => boolean) | null = null): string[] {
  if (!existsSync(absDir)) return [];
  const results: string[] = [];
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

export function sha256File(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

export function collectMigratedOutputs(repoRoot: string): MigratedOutputs {
  const srcRoot = join(repoRoot, "src");
  const tsFiles = walkDir(srcRoot, "", (rel) => rel.endsWith(".mts"));
  const outSet = new Set(tsFiles.map((rel) => rel.replace(/\.mts$/, ".mjs")));
  return { tsFiles, outSet };
}

export function collectUnmigratedFiles(repoRoot: string): string[] {
  const files: string[] = [];
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
}: VerifyDistFidelityOptions = {}): VerifyDistFidelityResult {
  const problems: string[] = [];
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
    const expectedPkg = buildDistManifest(JSON.parse(readFileSync(rootPkgPath, "utf8")) as PackageManifest);
    const actualPkg = JSON.parse(readFileSync(distPkgPath, "utf8")) as PackageManifest;
    if (JSON.stringify(expectedPkg) !== JSON.stringify(actualPkg)) {
      problems.push("dist/package.json 与从根目录推导的发布清单一不致");
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
