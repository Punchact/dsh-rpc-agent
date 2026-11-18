import assert from "node:assert/strict";
import test from "node:test";

import { ADAPTER_OPERATIONS, REPORT_STATES, reportOf, validateAdapter } from "../lib/adapters/base.mjs";
import { TASK_ERROR, isTaskError } from "../lib/tasks/errors.mjs";

function fullAdapter() {
  const obj = {};
  for (const op of ADAPTER_OPERATIONS) obj[op] = async () => ({});
  return obj;
}

test("validateAdapter accepts complete adapter and rejects each missing operation with INVALID_ADAPTER", () => {
  const valid = fullAdapter();
  assert.equal(validateAdapter(valid), valid);

  for (const bad of [null, undefined, "str", []]) {
    assert.throws(
      () => validateAdapter(bad),
      (err) => isTaskError(err, TASK_ERROR.INVALID_ADAPTER),
    );
  }

  for (const op of ADAPTER_OPERATIONS) {
    const missing = fullAdapter();
    delete missing[op];
    assert.throws(
      () => validateAdapter(missing),
      (err) => isTaskError(err, TASK_ERROR.INVALID_ADAPTER) && err.data?.operation === op,
    );

    const nonFn = fullAdapter();
    nonFn[op] = "not-a-fn";
    assert.throws(
      () => validateAdapter(nonFn),
      (err) => isTaskError(err, TASK_ERROR.INVALID_ADAPTER) && err.data?.operation === op,
    );
  }
});

test("reportOf accepts the six canonical states and rejects invalid states or non-object payloads", () => {
  for (const state of REPORT_STATES) {
    const r = reportOf(state, { detail: "ok" });
    assert.equal(r.state, state);
    assert.equal(r.detail, "ok");
  }

  for (const badState of ["completed", "unknown", "running", "", null, 123]) {
    assert.throws(
      () => reportOf(badState, {}),
      (err) => isTaskError(err, TASK_ERROR.REPORT_INVALID),
    );
  }

  for (const badPayload of [null, "text", []]) {
    assert.throws(
      () => reportOf("progress", badPayload),
      (err) => isTaskError(err, TASK_ERROR.REPORT_INVALID),
    );
  }
});
