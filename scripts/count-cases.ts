#!/usr/bin/env node
// 量一遍真实用例数，写进 docs/counts.json。
//
// 为什么必须真跑：0.9.2 复核指出 `counts.json` 的 `testCases` 是手填的，`--write` 会把写错的值
// 当正确答案刷进文档。手填的数字没有任何东西能证明它是真的。这里改成跑一次 `npm test` 链上的
// 全部测试（TAP 输出写到临时文件，不依赖管道），从 `# pass` 里取数；同时记下测试文件的内容
// 摘要与「声明的用例条数」，`check-docs` 靠这两项判断「这个数是刚量的，还是有人手改的」。
//
// 用法：
//   node scripts/count-cases.ts             量一次并打印（不落盘）
//   node scripts/count-cases.ts --record    量一次并写进 docs/counts.json
//
// 沙箱注意：本机沙箱禁止 Node 用管道拉子进程 stdio（EPERM），所以子进程用 inherit，
// TAP 用 `--test-reporter-destination` 直接落文件。

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

interface PackageJsonShape {
  scripts?: {
    test?: string;
  };
}

interface CountsJsonShape {
  note?: string;
}

export interface ChainDigestResult {
  files: number;
  digest: string;
  declared: number;
}

interface MeasureResult {
  pass: number;
  fail: number;
  skip: number;
  status: number | null;
  stderr: Buffer | string | null;
}

const REPO = fileURLToPath(new URL("..", import.meta.url));
const countsPath = join(REPO, "docs", "counts.json");
const packageJson = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as PackageJsonShape;

/** `npm test` 链上的测试文件（顺序即执行顺序）。 */
export function chainTestFiles(): string[] {
  const chain = String(packageJson.scripts?.test ?? "");
  return [...chain.matchAll(/node (test\/[A-Za-z0-9_.-]+\.test\.(?:mjs|ts))/g)].map((m) => m[1]);
}

/** 测试文件内容摘要 + 声明的用例条数：任何一个变了，旧数字就不可信。 */
export function chainDigest(files: string[] = chainTestFiles()): ChainDigestResult {
  const hash = createHash("sha256");
  let declared = 0;
  for (const rel of files) {
    const text = readFileSync(join(REPO, rel), "utf8");
    hash.update(`${rel}\n`);
    hash.update(text);
    hash.update("\n");
    // 粗算声明条数：静态值不必等于运行值（有用例是循环里生成的），它只用来发现「文件变了但数字没重算」。
    declared += (text.match(/^\s*(?:await\s+)?(?:t|test)\(\s*"/gm) ?? []).length;
  }
  return { files: files.length, digest: hash.digest("hex"), declared };
}

/** 真跑一遍，从 TAP 里取 `# pass`。 */
function measure(files: string[]): MeasureResult {
  const dir = mkdtempSync(join(tmpdir(), "dsh-count-"));
  const tapPath = join(dir, "tap.log");
  try {
    const res = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", `--test-reporter-destination=${tapPath}`, ...files],
      { cwd: REPO, stdio: "inherit" },
    );
    const tap = readFileSync(tapPath, "utf8");
    const pass = Number(/^# pass (\d+)$/m.exec(tap)?.[1] ?? NaN);
    const fail = Number(/^# fail (\d+)$/m.exec(tap)?.[1] ?? NaN);
    const skip = Number(/^# skipped (\d+)$/m.exec(tap)?.[1] ?? 0);
    return { pass, fail, skip, status: res.status, stderr: res.stderr ?? null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (await import("node:path")).resolve(process.argv[1]);
const record = process.argv.includes("--record");
if (isMain) {
  const files = chainTestFiles();
  const meta = chainDigest(files);
  const result = measure(files);

  if (!Number.isInteger(result.pass) || result.pass <= 0) {
    console.error("count-cases: TAP 里没读到用例数（测试可能没跑起来）");
    process.exit(1);
  }
  if (result.fail !== 0 || result.status !== 0) {
    console.error(`count-cases: 测试没全过（fail=${result.fail}, exit=${result.status}），拒绝记数`);
    process.exit(1);
  }

  console.log(`count-cases: 实测 ${result.pass} 例通过（0 失败）· ${meta.files} 个文件 · 声明 ${meta.declared} 条`);

  if (record) {
    const counts = {
      note: (JSON.parse(readFileSync(countsPath, "utf8")) as CountsJsonShape).note,
      testCases: result.pass,
      testFiles: meta.files,
      declaredCases: meta.declared,
      testChainDigest: meta.digest,
      measuredAt: new Date().toISOString(),
    };
    writeFileSync(countsPath, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`count-cases: 已写入 ${countsPath}`);
  } else {
    console.log("count-cases: 未加 --record，未落盘");
  }
}
