import assert from "node:assert/strict";
import test from "node:test";

import {
  ADAPTER_FAILURE_MESSAGES,
  ADAPTER_OPERATIONS,
  REPORT_STATES,
  reportOf,
  sanitizeAdapterFailure,
  validateAdapter,
} from "../lib/adapters/base.mjs";
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

test("sanitizeAdapterFailure strips raw text, paths, URLs, and oversized/invalid identifiers", () => {
  const unavailable = sanitizeAdapterFailure({
    taskCode: "ADAPTER_UNAVAILABLE",
    message: "connect ECONNREFUSED 127.0.0.1:4035 token=secret_abc",
    data: { kind: "ADAPTER_UNAVAILABLE", phase: "connect", httpStatus: 503 },
  });
  assert.equal(unavailable.code, "ADAPTER_UNAVAILABLE");
  assert.equal(unavailable.kind, "ADAPTER_UNAVAILABLE");
  assert.equal(unavailable.phase, "connect");
  assert.equal(unavailable.httpStatus, 503);
  assert.equal(unavailable.message, ADAPTER_FAILURE_MESSAGES.unavailable);
  assert.doesNotMatch(JSON.stringify(unavailable), /127\.0\.0\.1|4035|secret_abc|ECONNREFUSED/);

  const timeout = sanitizeAdapterFailure({
    code: "ETIMEDOUT",
    message: "timed out hitting http://127.0.0.1:4035/internal",
  });
  assert.equal(timeout.code, "ETIMEDOUT");
  assert.equal(timeout.message, ADAPTER_FAILURE_MESSAGES.timeout);

  const dirtyIds = sanitizeAdapterFailure({
    code: "has spaces / slashes http://evil",
    data: { kind: "x".repeat(80), phase: "ok-phase", httpStatus: 999 },
    message: "C:\\Users\\Andy\\secret.key",
  });
  assert.equal(dirtyIds.code, null);
  assert.equal(dirtyIds.kind, null);
  assert.equal(dirtyIds.phase, "ok-phase");
  assert.equal(dirtyIds.httpStatus, null);
  assert.equal(dirtyIds.message, ADAPTER_FAILURE_MESSAGES.rejected);
  assert.doesNotMatch(JSON.stringify(dirtyIds), /secret\.key|evil|Users/);
});
