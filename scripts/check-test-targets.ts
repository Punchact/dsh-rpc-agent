#!/usr/bin/env node
// Verify that every file under `test/**/*.mjs` (including `test/helpers/**`) imports
// built artifacts under `dist/` rather than pointing back to unbuilt source paths
// (`../lib/`, `../bin/`, `../index.mjs`, `../client.js`, `../http-client.mjs`).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface DiscoveredTestFile {
  rel: string;
  full: string;
}

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TEST_ROOT = join(REPO, "test");

function walkMjs(absDir: string, relPrefix = ""): DiscoveredTestFile[] {
  if (!existsSync(absDir)) return [];
  const results: DiscoveredTestFile[] = [];
  const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const rel = relPrefix ? posix.join(relPrefix, entry.name) : entry.name;
    const full = join(absDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMjs(full, rel));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      results.push({ rel: posix.join("test", rel), full });
    }
  }
  return results;
}

const SOURCE_IMPORT_RE =
  /(["'])(?:\.\.\/)+(?:lib\/|bin\/|index\.mjs|client\.js|http-client\.mjs)/g;
const SOURCE_SPAWN_BIN_RE = /\bjoin\(\s*REPO\s*,\s*(["'])bin\1/g;
const DIST_REF_RE =
  /(["'])(?:\.\.\/)+dist\/(?:lib\/|bin\/|index\.mjs|client\.js|http-client\.mjs|package\.json|cordis\.patch\.yml)|join\(\s*REPO\s*,\s*(["'])dist\2\s*,\s*(["'])bin\3/g;

const files = walkMjs(TEST_ROOT);
const violations: string[] = [];
let distRefCount = 0;

for (const file of files) {
  const lines = readFileSync(file.full, "utf8").split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const lineNo = idx + 1;
    for (const m of line.matchAll(SOURCE_IMPORT_RE)) {
      violations.push(`${file.rel}:${lineNo}: 禁止指向源码路径 ${m[0].slice(1)}`);
    }
    for (const m of line.matchAll(SOURCE_SPAWN_BIN_RE)) {
      violations.push(`${file.rel}:${lineNo}: 禁止直接拉起源码目录 bin (${m[0]})`);
    }
    for (const _ of line.matchAll(DIST_REF_RE)) {
      distRefCount += 1;
    }
  }
}

if (violations.length > 0) {
  console.error(`check-test-targets: FAIL (${violations.length})`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(
  `check-test-targets: ok — 检查 ${files.length} 个测试文件，${distRefCount} 处产物引用全部指向 dist/（0 处指回源码）`,
);
