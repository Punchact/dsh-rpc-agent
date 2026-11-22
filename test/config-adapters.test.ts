import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, resolveConfig } from "../dist/lib/config.mjs";

// `asAdaptersMap` builds a clean object, so any key it does not whitelist disappears
// without a word. These tests pin the keys that stay: a numeric knob that is documented
// in README but dropped here would look configurable and behave fixed.

test("numeric adapter knobs survive configuration", () => {
  const cfg = resolveConfig({
    tasksAdapters: {
      codex: { enabled: true, interruptConfirmMs: 8_000, probeTimeoutMs: 2_500 },
    },
  });

  const codex = cfg.tasksAdapters.codex;
  assert.equal(codex?.enabled, true);
  assert.equal(codex?.interruptConfirmMs, 8_000);
  assert.equal(codex?.probeTimeoutMs, 2_500);
});

test("a fractional window is floored, not carried into the adapter as a float", () => {
  const cfg = resolveConfig({ tasksAdapters: { codex: { interruptConfirmMs: 8_000.9 } } });
  assert.equal(cfg.tasksAdapters.codex?.interruptConfirmMs, 8_000);
});

test("zero means never wait, and it is accepted rather than read as missing", () => {
  const cfg = resolveConfig({ tasksAdapters: { codex: { interruptConfirmMs: 0 } } });
  assert.equal(cfg.tasksAdapters.codex?.interruptConfirmMs, 0);
});

test("a numeric knob written as a string is refused, not coerced", () => {
  assert.throws(
    () => resolveConfig({ tasksAdapters: { codex: { interruptConfirmMs: "8000" } } }),
    (err: unknown) => err instanceof ConfigError && /tasksAdapters/.test((err as Error).message),
  );
});

test("out-of-range windows are refused with the key named", () => {
  const badCases: Array<Record<string, unknown>> = [
    { interruptConfirmMs: -1 },
    { interruptConfirmMs: 60_001 },
    { probeTimeoutMs: 50 },
    { probeTimeoutMs: 60_001 },
    { interruptConfirmMs: Number.NaN },
  ];

  for (const bad of badCases) {
    assert.throws(
      () => resolveConfig({ tasksAdapters: { codex: bad } }),
      (err: unknown) => err instanceof ConfigError && /tasksAdapters/.test((err as Error).message),
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

test("keys the bridge does not know are still dropped, so the whitelist stays honest", () => {
  const cfg = resolveConfig({ tasksAdapters: { codex: { enabled: true, nonsense: 1 } } });
  assert.deepEqual(Object.keys(cfg.tasksAdapters.codex ?? {}).sort(), ["enabled"]);
});
