import assert from "node:assert/strict";
import test from "node:test";

import { TIMEOUT_ADVICE, shouldAdviseTimeout } from "../dist/lib/advice.mjs";
import { ConfigError, MAX_RESULT_CHARS, MIN_RESULT_CHARS, describeConfig, resolveConfig } from "../dist/lib/config.mjs";

test("TIMEOUT_ADVICE explains outer client cap and wait:false + since workflow", () => {
  assert.match(TIMEOUT_ADVICE, /tool_timeout_sec/);
  assert.match(TIMEOUT_ADVICE, /dsh_ask\(\{wait:false\}\)/);
  assert.match(TIMEOUT_ADVICE, /dsh_wait\(\{session_id, since:cursor\}\)/);
});

test("shouldAdviseTimeout covers enabled, alreadyShown, timeout flags, and 600000 boundary", () => {
  // Default enabled + not shown + timedOut + 600000 boundary -> true
  assert.equal(shouldAdviseTimeout({ timedOut: true, requestedMs: 600_000 }), true);
  assert.equal(shouldAdviseTimeout({ status: "timeout", requestedMs: 600_000 }), true);
  assert.equal(
    shouldAdviseTimeout({ status: "timeout", timedOut: true, requestedMs: 900_000, enabled: true, alreadyShown: false }),
    true,
  );

  // Boundary: 599999 -> false, 600000 -> true
  assert.equal(shouldAdviseTimeout({ status: "timeout", requestedMs: 599_999 }), false);
  assert.equal(shouldAdviseTimeout({ timedOut: true, requestedMs: 599_999 }), false);
  assert.equal(shouldAdviseTimeout({ timedOut: true, requestedMs: 600_000 }), true);

  // enabled / alreadyShown gates
  assert.equal(shouldAdviseTimeout({ status: "timeout", requestedMs: 600_000, enabled: false }), false);
  assert.equal(shouldAdviseTimeout({ status: "timeout", requestedMs: 600_000, alreadyShown: true }), false);

  // Neither timedOut nor status === "timeout"
  assert.equal(shouldAdviseTimeout({ status: "completed", timedOut: false, requestedMs: 600_000 }), false);
  assert.equal(shouldAdviseTimeout({ status: "running", requestedMs: 600_000 }), false);
  assert.equal(shouldAdviseTimeout({ status: "timeout-ish", timedOut: "true", requestedMs: 600_000 }), false);
});

test("shouldAdviseTimeout never throws on garbage inputs", () => {
  for (const input of [
    undefined,
    null,
    false,
    true,
    0,
    600_000,
    "timeout",
    [],
    {},
    () => {},
    { status: "timeout", requestedMs: NaN },
    { status: "timeout", requestedMs: Infinity },
    { status: "timeout", requestedMs: 600_000.5 },
    { status: "timeout", requestedMs: "600000" },
    { status: "timeout", requestedMs: -600_000 },
  ]) {
    assert.equal(shouldAdviseTimeout(input), false);
  }
});

test("config resolves, validates, and describes maxResultChars and timeoutAdvice", () => {
  assert.equal(MIN_RESULT_CHARS, 0);
  assert.equal(MAX_RESULT_CHARS, 200_000);

  const def = resolveConfig({});
  assert.equal(def.maxResultChars, 20_000);
  assert.equal(def.timeoutAdvice, true);
  assert.equal(describeConfig(def).maxResultChars, 20_000);
  assert.equal(describeConfig(def).timeoutAdvice, true);

  const uncapped = resolveConfig({ maxResultChars: 0, timeoutAdvice: false });
  assert.equal(uncapped.maxResultChars, 0);
  assert.equal(uncapped.timeoutAdvice, false);
  assert.equal(describeConfig(uncapped).maxResultChars, 0);
  assert.equal(describeConfig(uncapped).timeoutAdvice, false);

  const max = resolveConfig({ maxResultChars: 200_000 });
  assert.equal(max.maxResultChars, 200_000);

  for (const bad of [-1, 200_001, 1.5, "20000", null, NaN]) {
    assert.throws(
      () => resolveConfig({ maxResultChars: bad }),
      (err) => err instanceof ConfigError && err.problems.some((p: string) => p.startsWith("maxResultChars:")),
    );
  }

  for (const bad of ["true", 1, 0, null]) {
    assert.throws(
      () => resolveConfig({ timeoutAdvice: bad }),
      (err) => err instanceof ConfigError && err.problems.some((p: string) => p.startsWith("timeoutAdvice:")),
    );
  }
});
