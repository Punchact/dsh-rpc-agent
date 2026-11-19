import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { APPROVAL_MODES, ConfigError, describeConfig, resolveConfig } from "../dist/lib/config.mjs";

test("circuit-breaker defaults match §9 and appear in describeConfig", () => {
  const cfg = resolveConfig({});
  assert.equal(cfg.tasksEnabled, false);
  assert.equal(cfg.tasksMaxConcurrent, 1);
  assert.equal(cfg.tasksRequireReconcileOnUnknown, true);
  assert.equal(cfg.tasksExternalAdapter, "none");
  assert.equal(cfg.tasksPreviewTtlMs, 300_000);

  const pub = describeConfig(cfg);
  assert.equal(pub.tasksEnabled, false);
  assert.equal(pub.tasksMaxConcurrent, 1);
  assert.equal(pub.tasksRequireReconcileOnUnknown, true);
  assert.equal(pub.tasksExternalAdapter, "none");
  assert.equal(pub.tasksPreviewTtlMs, 300_000);
});

test("circuit-breaker switches accept all valid values", () => {
  for (const adapter of ["none", "antigravity", "codex"]) {
    const cfg = resolveConfig({
      tasksEnabled: true,
      tasksMaxConcurrent: 32,
      tasksRequireReconcileOnUnknown: false,
      tasksExternalAdapter: adapter,
      tasksPreviewTtlMs: 60_000,
    });
    const pub = describeConfig(cfg);
    assert.equal(pub.tasksEnabled, true);
    assert.equal(pub.tasksMaxConcurrent, 32);
    assert.equal(pub.tasksRequireReconcileOnUnknown, false);
    assert.equal(pub.tasksExternalAdapter, adapter);
    assert.equal(pub.tasksPreviewTtlMs, 60_000);
  }
});

test("circuit-breaker switches reject invalid values with ConfigError naming the key", () => {
  const badCases = [
    [{ tasksEnabled: "true" }, /tasksEnabled/],
    [{ tasksMaxConcurrent: 0 }, /tasksMaxConcurrent/],
    [{ tasksMaxConcurrent: 33 }, /tasksMaxConcurrent/],
    [{ tasksMaxConcurrent: 1.5 }, /tasksMaxConcurrent/],
    [{ tasksRequireReconcileOnUnknown: 1 }, /tasksRequireReconcileOnUnknown/],
    [{ tasksExternalAdapter: "cursor" }, /tasksExternalAdapter/],
    [{ tasksPreviewTtlMs: 999 }, /tasksPreviewTtlMs/],
  ];

  for (const [input, pattern] of badCases) {
    assert.throws(
      () => resolveConfig(input),
      (err) => err instanceof ConfigError && pattern.test(err.message),
    );
  }
});

test("remaining migrated modules (config, auth, version, registry, stats, redact, owned, inflight, advice) enforce TypeScript contracts", () => {
  assert.deepEqual([...APPROVAL_MODES], ["off", "deny", "delegate"]);

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const validProbe = resolve(repoRoot, "src/__pr5b_valid_probe__.mts");
  const badProbe = resolve(repoRoot, "src/__pr5b_bad_probe__.mts");

  const validSource = `
import { describeConfig, resolveConfig, type DescribedConfig, type ResolvedConfig } from "./lib/config.mjs";
import { loadOrCreateToken, type LoadOrCreateTokenResult } from "./lib/auth.mjs";
import { PLUGIN_VERSION, PROTOCOL_VERSION } from "./lib/version.mjs";
import { shouldAdviseTimeout, type ShouldAdviseTimeoutInput } from "./lib/advice.mjs";
import { createInflight, type InflightRegistry } from "./lib/inflight.mjs";
import { createStats, type StatsTracker } from "./lib/stats.mjs";
import { redactSecrets } from "./lib/adapters/redact.mjs";
import { isOwnedSession } from "./lib/owned.mjs";
import { registryKey, type StickyRegistryEntry } from "./lib/registry.mjs";

const _cfg: ResolvedConfig = resolveConfig({ tasksEnabled: false });
const _desc: DescribedConfig = describeConfig(_cfg);
const _tok: (c: ResolvedConfig) => LoadOrCreateTokenResult = (c) => loadOrCreateToken(c);
const _ver: string = PLUGIN_VERSION + PROTOCOL_VERSION;
const _adv: boolean = shouldAdviseTimeout({ status: "timeout", requestedMs: 600000 } satisfies ShouldAdviseTimeoutInput);
const _inf: InflightRegistry = createInflight();
const _stats: StatsTracker = createStats();
const _red: string = redactSecrets("Bearer secret-token");
const _own: boolean = isOwnedSession("s-1");
const _key: string | null = registryKey({ project: "repo" });
const _regCheck = (e: StickyRegistryEntry) => e.sessionId;
void [_desc, _tok, _ver, _adv, _inf, _stats, _red, _own, _key, _regCheck];
`;

  const badSource = `
import { describeConfig, resolveConfig } from "./lib/config.mjs";
import { writeEndpoint } from "./lib/auth.mjs";
import { createInflight } from "./lib/inflight.mjs";
import { rememberEntry } from "./lib/registry.mjs";

void resolveConfig("not-an-object");
void describeConfig({ tasksEnabled: "yes" });
void writeEndpoint({ url: "http://127.0.0.1:1" });
void createInflight().settle("1", "not-a-controller");
void rememberEntry("k", { missingSessionId: true });
`;

  const configPath = resolve(repoRoot, "tsconfig.json");
  const parsed = ts.readConfigFile(configPath, ts.sys.readFile);
  const cmd = ts.parseJsonConfigFileContent(parsed.config, ts.sys, repoRoot);
  const options = { ...cmd.options, noEmit: true };

  const runProbe = (filePath, content) => {
    const virtualFiles = new Map([[resolve(filePath), content]]);
    const host = ts.createCompilerHost(options, true);
    const origGetSourceFile = host.getSourceFile.bind(host);
    const origFileExists = host.fileExists.bind(host);
    host.fileExists = (p) => virtualFiles.has(resolve(p)) || origFileExists(p);
    host.getSourceFile = (p, lang) => {
      const hit = virtualFiles.get(resolve(p));
      if (hit !== undefined) return ts.createSourceFile(p, hit, lang, true);
      return origGetSourceFile(p, lang);
    };
    host.writeFile = () => {
      throw new Error("unexpected write during in-memory compiler check");
    };
    const program = ts.createProgram([filePath], options, host);
    return ts.getPreEmitDiagnostics(program).filter((d) => d.file && resolve(d.file.fileName) === resolve(filePath));
  };

  assert.deepEqual(
    runProbe(validProbe, validSource).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    [],
  );
  const badDiagnostics = runProbe(badProbe, badSource);
  assert.ok(badDiagnostics.length >= 5, `expected >= 5 compile-time rejections, got ${badDiagnostics.length}`);
});
