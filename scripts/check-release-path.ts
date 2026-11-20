#!/usr/bin/env node
// Verify the full release path:
//   1. `dist/` packs cleanly and every declared `main` / `exports` / `bin` entry is inside its tarball.
//   2. Root workspace does not ship a publishable broken manifest (either `private: true` with no
//      publish `files` list, or every root-declared entry is in the root tarball); all root-declared
//      local entry paths resolve on disk.
//   3. `.github/workflows/release.yml` builds `dist/` first and publishes from `dist/` (`cd dist` or
//      `npm pack dist`), never directly from repo root.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXPECTED_DIST_FILES } from "./publish-manifest.ts";

interface NpmPackFileEntry {
  path: string;
}

interface NpmPackManifest {
  files: NpmPackFileEntry[];
}

interface PackageJsonShape {
  private?: boolean;
  main?: string;
  exports?: Record<string, unknown>;
  bin?: Record<string, unknown>;
  scripts?: {
    prepublishOnly?: string;
  };
}

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = resolve(REPO, "dist");
const RELEASE_WORKFLOW = resolve(REPO, ".github", "workflows", "release.yml");

const problems: string[] = [];

function runNpmPackDryRun(cwd: string): NpmPackManifest | null {
  const npmExec = process.env.npm_execpath;
  const useShell = !npmExec && process.platform === "win32";
  const command = npmExec ? process.execPath : useShell ? "npm.cmd" : "npm";
  const args = ["pack", "--dry-run", "--json"];
  const out = useShell
    ? spawnSync(`${command} ${args.join(" ")}`, { cwd, encoding: "utf8", shell: true, timeout: 120_000 })
    : spawnSync(command, npmExec ? [npmExec, ...args] : args, { cwd, encoding: "utf8", timeout: 120_000 });
  if (out.error) {
    problems.push(`npm pack (${cwd}) 执行失败: ${out.error.message}`);
    return null;
  }
  if (out.status !== 0) {
    problems.push(`npm pack (${cwd}) 退出码 ${out.status}: ${(out.stderr || out.stdout || "").trim().slice(0, 300)}`);
    return null;
  }
  const start = out.stdout.indexOf("[");
  if (start < 0) {
    problems.push(`npm pack (${cwd}) 未输出 JSON`);
    return null;
  }
  try {
    const parsed = JSON.parse(out.stdout.slice(start)) as unknown;
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed[0] as NpmPackManifest) : null;
  } catch (err) {
    problems.push(`npm pack (${cwd}) JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function collectDeclaredTargets(pkg: PackageJsonShape): Array<[string, string]> {
  const list: Array<[string, string]> = [];
  if (typeof pkg.main === "string") list.push(["main", pkg.main]);
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target === "string") list.push([`exports["${subpath}"]`, target]);
  }
  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    if (typeof target === "string") list.push([`bin["${name}"]`, target]);
  }
  return list;
}

// Comment lines must not satisfy a workflow assertion: a `# - run: npm run build` sitting above
// `check:version` would otherwise look like a build step that never runs.
function stripComments(block: string): string {
  return block
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

// Every `npm (stage) publish` line must either run inside `dist/` (subshell or a preceding `cd dist`
// in the same shell step) or publish an explicit artifact path (a tarball). Anything else is a root
// publish — the exact mistake this whole check exists to catch. Positions matter: a line that only
// reaches `cd dist` *after* its first `npm publish` is still a root publish.
const PUBLISH_CALL = /npm\s+(?:stage\s+)?publish\b/g;

// A message that merely *mentions* `npm publish` inside quotes is not a publish step. Replace quoted
// spans with spaces of the same length so match positions stay aligned with the real line.
function maskQuotedSpans(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (span) => " ".repeat(span.length));
}

function findRootPublishLines(publishBlock: string): string[] {
  const offenders: string[] = [];
  let inDistDir = false;
  for (const raw of publishBlock.split("\n")) {
    const line = raw.trim();
    if (/^cd\s+dist\b/.test(line) || /^push-location\s+dist\b/i.test(line)) inDistDir = true;
    if (/^(?:cd\s+\.\.|popd|leave-)/i.test(line)) inDistDir = false;
    const masked = maskQuotedSpans(line);
    PUBLISH_CALL.lastIndex = 0;
    let match = PUBLISH_CALL.exec(masked);
    while (match) {
      const before = masked.slice(0, match.index);
      const selfContained = /\(\s*cd\s+dist\b/.test(before) || /\bcd\s+dist\s*(?:&&|;)/.test(before);
      const publishesArtifact = /^npm\s+(?:stage\s+)?publish\s+["']/.test(line.slice(match.index));
      if (!selfContained && !inDistDir && !publishesArtifact) offenders.push(line);
      match = PUBLISH_CALL.exec(masked);
    }
  }
  return offenders;
}

// Every publish call in the publish job must name the tarball it downloaded. Checking that *some*
// call mentions $TARBALL is not enough: a real `cd dist && npm publish` branch sitting next to a
// rehearsal line that does name it passed the gate (quality review round, 0.9.4 finding 1).
function nonTarballPublishLines(publishBlock: string): string[] {
  const offenders: string[] = [];
  for (const raw of publishBlock.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const masked = maskQuotedSpans(line);
    PUBLISH_CALL.lastIndex = 0;
    let match = PUBLISH_CALL.exec(masked);
    while (match) {
      const tail = line.slice(match.index);
      const namesTarball = /\$\{?TARBALL\b|\bartifacts\//.test(tail) || /\.tgz\b/.test(tail);
      if (!namesTarball) offenders.push(line);
      match = PUBLISH_CALL.exec(masked);
    }
  }
  return offenders;
}

// The artifact name an upload/download step declares, so verify and publish can be compared. Stops
// at the next step so a later step's `name:` cannot be mistaken for this one's.
function artifactName(block: string, verb: string): string | null {
  const marker = `uses: actions/${verb}-artifact@`;
  const at = block.indexOf(marker);
  if (at < 0) return null;
  for (const line of block.slice(at).split("\n").slice(1)) {
    if (/^\s{0,6}-\s/.test(line)) return null;
    const match = /^name:\s*([A-Za-z0-9._-]+)$/.exec(line.trim());
    if (match) return match[1] ?? null;
  }
  return null;
}

function checkWildcardInPack(baseDir: string, shippedSet: Set<string>, pattern: string): boolean {  const relPattern = pattern.replace(/^\.\//, "");
  const dirRel = posix.dirname(relPattern);
  const basePattern = posix.basename(relPattern);
  const parts = basePattern.split("*");
  const prefix = parts[0] ?? "";
  const suffix = parts[1] ?? "";
  const absDir = resolve(baseDir, dirRel);
  if (!existsSync(absDir)) return false;
  const matches = readdirSync(absDir).filter((f) => f.startsWith(prefix) && f.endsWith(suffix));
  if (matches.length === 0) return false;
  return matches.every((f) => shippedSet.has(posix.join(dirRel, f)));
}

// 1. Verify dist/ pack contains every declared entry
if (!existsSync(DIST) || !existsSync(resolve(DIST, "package.json"))) {
  problems.push("dist/ 或 dist/package.json 缺失 — 请先运行 `npm run build`");
} else {
  const distPkg = JSON.parse(readFileSync(resolve(DIST, "package.json"), "utf8")) as PackageJsonShape;
  if (distPkg.private === true) {
    problems.push('dist/package.json 带有 "private": true，无法发布');
  }
  if (distPkg.scripts?.prepublishOnly) {
    problems.push("dist/package.json 不应保留指向仓库脚本的 prepublishOnly");
  }
  const distManifest = runNpmPackDryRun(DIST);
  if (distManifest) {
    const distShipped = new Set(distManifest.files.map((f) => f.path.split("\\").join("/")));
    for (const [label, target] of collectDeclaredTargets(distPkg)) {
      if (target.includes("*")) {
        if (!checkWildcardInPack(DIST, distShipped, target)) {
          problems.push(`dist pack 清单缺失通配目标 ${label} -> ${target}`);
        }
      } else {
        const rel = target.replace(/^\.\//, "");
        if (!distShipped.has(rel)) {
          problems.push(`dist pack 清单缺失 ${label} -> ${target}`);
        }
      }
    }
  }
}

// 2. Verify repo root manifest consistency & unpublishable guard
const rootPkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as PackageJsonShape;
const rootDeclared = collectDeclaredTargets(rootPkg);
for (const [label, target] of rootDeclared) {
  if (target.includes("*")) {
    const dirRel = posix.dirname(target.replace(/^\.\//, ""));
    if (!existsSync(resolve(REPO, dirRel))) {
      problems.push(`根目录 package.json ${label} 指向不存在目录 ${target}`);
    }
  } else {
    const rel = target.replace(/^\.\//, "");
    if (!existsSync(resolve(REPO, rel))) {
      problems.push(`根目录 package.json ${label} 存在死引用 -> ${target}`);
    }
  }
}

const rootManifest = runNpmPackDryRun(REPO);
if (rootManifest) {
  const rootShipped = new Set(rootManifest.files.map((f) => f.path.split("\\").join("/")));
  const rootUnpublishable = rootPkg.private === true && !Object.hasOwn(rootPkg, "files");
  if (!rootUnpublishable) {
    for (const [label, target] of rootDeclared) {
      if (target.includes("*")) continue;
      const rel = target.replace(/^\.\//, "");
      if (!rootShipped.has(rel)) {
        problems.push(`根目录可发布且 root npm pack 清单缺失声明入口 ${label} -> ${target}`);
      }
    }
  }
}

// 3. Verify release.yml builds and publishes strictly from dist/
if (!existsSync(RELEASE_WORKFLOW)) {
  problems.push("缺少 .github/workflows/release.yml");
} else {
  const yml = readFileSync(RELEASE_WORKFLOW, "utf8").replace(/\r\n/g, "\n");
  const verifyIdx = yml.indexOf("\n  verify:");
  const publishIdx = yml.indexOf("\n  publish:");
  if (verifyIdx < 0 || publishIdx < 0) {
    problems.push("release.yml 缺少 verify 或 publish job");
  } else {
    const verifyBlock = stripComments(yml.slice(verifyIdx, publishIdx));
    const publishBlock = stripComments(yml.slice(publishIdx));

    const buildPos = verifyBlock.indexOf("npm run build");
    const checkVersionPos = verifyBlock.indexOf("npm run check:version");
    if (checkVersionPos >= 0 && (buildPos < 0 || buildPos > checkVersionPos)) {
      problems.push(
        "release.yml verify job 没有把 npm run build 放在 check:version 之前，全新检出上 check:version 读不到 dist/lib/version.mjs",
      );
    }

    // The published bytes have to be the verified bytes. That means: verify packs `dist/` into a
    // tarball, uploads it, publish downloads that same artifact, checks its digest, and never
    // rebuilds. Until 0.9.4 the publish job rebuilt from the same commit and published whatever the
    // second build produced, so `verify` only vouched for a sibling artifact (quality review,
    // 0.9.4 finding 1).
    if (!/npm\s+pack\s+(?:\.\/)?dist\b/.test(verifyBlock)) {
      problems.push("release.yml verify job 没有把 dist 打包成 tarball（npm pack ./dist），发布物与验证物无法绑定");
    }
    const uploadedArtifact = artifactName(verifyBlock, "upload");
    const downloadedArtifact = artifactName(publishBlock, "download");
    if (!uploadedArtifact) {
      problems.push("release.yml verify job 没有用 upload-artifact 上传 tarball（缺少 name）");
    }
    if (!downloadedArtifact) {
      problems.push("release.yml publish job 没有用 download-artifact 取回 tarball（缺少 name）");
    }
    if (uploadedArtifact && downloadedArtifact && uploadedArtifact !== downloadedArtifact) {
      problems.push(
        `release.yml 上传与下载的 artifact 名字不一致（${uploadedArtifact} vs ${downloadedArtifact}）`,
      );
    }
    if (!/sha256sum\s+-c\b/.test(publishBlock)) {
      problems.push("release.yml publish job 没有校验下载到的 tarball 摘要（sha256sum -c SHA256SUMS）");
    }
    if (/npm\s+run\s+build\b/.test(publishBlock)) {
      problems.push("release.yml publish job 仍在自行构建（npm run build），发布物必须是 verify 打包的那份 tarball");
    }
    if (!/npm\s+(?:stage\s+)?publish\s+["']?(?:\$\{?TARBALL|\.?\/?artifacts\/)/.test(publishBlock)) {
      problems.push("release.yml publish job 没有把发布目标指向下载到的 tarball（应 publish $TARBALL 或 ./artifacts/*.tgz）");
    }
    const strayPublish = nonTarballPublishLines(publishBlock);
    if (strayPublish[0] !== undefined) {
      problems.push(
        `release.yml publish job 有 ${strayPublish.length} 处 publish 没有指向 tarball：${strayPublish[0].slice(0, 120)}`,
      );
    }
    const tarAssign = [...publishBlock.matchAll(/TARBALL=(?<value>.*)/g)].map((m) =>
      (m.groups?.value ?? "").trim(),
    );
    if (tarAssign.length === 0) {
      problems.push("release.yml publish job 没有从下载到的 tarball 推出路径变量（应有 TARBALL=$(ls artifacts/*.tgz)）");
    } else if (!tarAssign.every((value) => value.includes("./"))) {
      problems.push(
        "release.yml publish job 的 TARBALL 赋值缺 `./` 前缀：npm 11 会把不带 ./ 的相对路径当 GitHub 简写包名，去 git ls-remote（dry_run 实测 exit 128）",
      );
    }
    const bareRootPublish = findRootPublishLines(publishBlock);
    if (bareRootPublish[0] !== undefined) {
      problems.push(
        `release.yml publish job 有 ${bareRootPublish.length} 处在仓库根执行 npm publish：${bareRootPublish[0].slice(0, 120)}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`check-release-path: FAIL (${problems.length})`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const distFilesCount = existsSync(DIST) && existsSync(resolve(DIST, "package.json")) ? String(EXPECTED_DIST_FILES) : "?";
console.log(
  `check-release-path: ok — dist 包校验通过（预期 ${distFilesCount} 文件，main/exports/bin 全在包内）；根目录 private=${Boolean(rootPkg.private)}（无 files 字段，0 死入口）；release.yml 在 verify 打包上传、publish 校验摘要后发布同一份 tarball（不重新构建）`,
);
