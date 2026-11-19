import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, describeConfig, resolveConfig } from "../dist/lib/config.mjs";

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
