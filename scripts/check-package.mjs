#!/usr/bin/env node
// Verify that what npm would publish is a complete, self-contained plugin.
//
// The failure this guards against is quiet: `files` in package.json decides the tarball, and a
// missing entry produces a package that installs cleanly and then dies when the Host imports it
// — with no error a user can act on. So instead of trusting the list, ask npm what it would pack
// and then check that every file the code actually imports is inside that set.
//
// No dependencies: only node builtins.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const REQUIRED = [
  "package.json",
  "index.mjs",
  "client.js",
  "cordis.patch.yml",
  "icon.svg",
  "LICENSE",
  "README.md",
  "README.en.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "locale/en.json",
  "locale/zh.json",
  "bin/dsh-rpc.mjs",
  "bin/dsh-rpc-mcp.mjs",
];

// Tests and tooling are repo-only: shipping them would put probe scripts in every user's
// node_modules and, worse, invite them to be run from an install whose Harness is not running.
const FORBIDDEN_PREFIXES = ["test/", "scripts/", "node_modules/"];

const problems = [];

function fail(message) {
  problems.push(message);
}

function packList() {
  // A sandbox that forbids spawning cmd.exe cannot run npm at all (measured 2026-11-06:
  // `spawnSync C:\WINDOWS\system32\cmd.exe EPERM` under DSH's workspace-write policy). Rather
  // than skip the check, accept an already-captured `npm pack --dry-run --json` document: the
  // assertions below are about what npm decided, not about who ran it.
  const captured = process.env.CHECK_PACKAGE_JSON;
  if (captured) {
    try {
      return JSON.parse(readFileSync(resolve(captured), "utf8"));
    } catch (error) {
      fail(`could not read CHECK_PACKAGE_JSON=${captured}: ${error.message}`);
      return null;
    }
  }

  // On Windows npm is a .cmd shim, which spawnSync refuses without a shell; when npm itself
  // started us (prepublishOnly) it hands us the real JS entry, so prefer that and stay shell-free.
  const npmExec = process.env.npm_execpath;
  const useShell = !npmExec && process.platform === "win32";
  const command = npmExec ? process.execPath : useShell ? "npm.cmd" : "npm";
  const args = ["pack", "--dry-run", "--json"];
  // A single command string in shell mode: passing an args array alongside `shell` is deprecated.
  const out = useShell
    ? spawnSync(`${command} ${args.join(" ")}`, {
        cwd: root,
        encoding: "utf8",
        shell: true,
        timeout: 120000,
      })
    : spawnSync(command, npmExec ? [npmExec, ...args] : args, {
        cwd: root,
        encoding: "utf8",
        timeout: 120000,
      });
  if (out.error) {
    fail(
      `could not run npm pack: ${out.error.message}` +
        (out.error.code === "EPERM"
          ? ' — spawning a shell is blocked here; capture `npm pack --dry-run --json` yourself and pass CHECK_PACKAGE_JSON=<file>'
          : ""),
    );
    return null;
  }
  if (out.status !== 0) {
    fail(`npm pack exited ${out.status}: ${(out.stderr || out.stdout || "").trim().slice(0, 400)}`);
    return null;
  }
  // npm may print notices on stderr; the JSON document is on stdout.
  const start = out.stdout.indexOf("[");
  if (start < 0) {
    fail("npm pack printed no JSON");
    return null;
  }
  try {
    return JSON.parse(out.stdout.slice(start));
  } catch (error) {
    fail(`could not parse npm pack output: ${error.message}`);
    return null;
  }
}

const packed = packList();
if (!packed || packed.length !== 1) {
  console.error(`check-package: FAIL\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

const manifest = packed[0];
const shipped = new Set(manifest.files.map((entry) => entry.path.split("\\").join("/")));

for (const path of REQUIRED) {
  if (!shipped.has(path)) fail(`required file is not in the tarball: ${path}`);
}

for (const path of shipped) {
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (path.startsWith(prefix)) fail(`repo-only path would be published: ${path}`);
  }
}

// package.json promises things by path; every promise must resolve inside the tarball.
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

// A tarball check cannot tell "publishable" from "not publishable": `npm publish --dry-run`
// exits 0 even when `private` is true (measured 2026-11-05, npm 11.19). npm only refuses at the
// real publish, i.e. after a tag and a GitHub Release — the worst possible moment to learn this.
// So assert the two fields here, where it costs one line.
if (pkg.private === true) {
  fail('package.json has "private": true — npm refuses to publish it, and --dry-run will not tell you');
}
if (pkg.publishConfig?.access !== "public") {
  fail(`publishConfig.access must be "public", got ${JSON.stringify(pkg.publishConfig?.access)}`);
}

const promised = [];
if (pkg.main) promised.push(["main", pkg.main]);
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  if (typeof value === "string" && !value.includes("*")) promised.push([`exports "${key}"`, value]);
}
for (const [name, value] of Object.entries(pkg.bin ?? {})) promised.push([`bin "${name}"`, value]);
if (pkg.icon) promised.push(["icon", pkg.icon]);
if (pkg.dsh?.bundle?.patch) promised.push(["dsh.bundle.patch", pkg.dsh.bundle.patch]);
for (const [label, target] of promised) {
  const path = target.replace(/^\.\//, "");
  if (!shipped.has(path)) fail(`${label} points at a file outside the tarball: ${target}`);
}

// Walk relative imports in every published module and confirm the target ships too. A bare
// specifier is left alone: this package has no runtime dependency to resolve.
const IMPORT = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
for (const path of shipped) {
  if (!path.endsWith(".mjs") && !path.endsWith(".js")) continue;
  const source = readFileSync(resolve(root, path), "utf8");
  for (const match of source.matchAll(IMPORT)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const target = posix.normalize(posix.join(posix.dirname(path), specifier));
    if (!shipped.has(target)) fail(`${path} imports "${specifier}" which is not published (${target})`);
    else if (!existsSync(resolve(root, target))) fail(`${path} imports ${target} but that file is missing on disk`);
  }
}

const megabytes = (manifest.unpackedSize / 1024).toFixed(1);
if (problems.length > 0) {
  console.error(`check-package: FAIL (${problems.length})`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `check-package: ok — ${manifest.name}@${manifest.version}, ` +
    `${manifest.entryCount} files, ${megabytes} KB unpacked, ` +
    `${(manifest.size / 1024).toFixed(1)} KB packed`,
);
