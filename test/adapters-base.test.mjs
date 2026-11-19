import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  ADAPTER_FAILURE_MESSAGES,
  ADAPTER_OPERATIONS,
  ADAPTER_REASON_MESSAGES,
  REPORT_STATES,
  assertAdapterOperation,
  isAdapterOperation,
  reportOf,
  sanitizeAdapterFailure,
  validateAdapter,
} from "../dist/lib/adapters/base.mjs";
import { TASK_ERROR, isTaskError } from "../dist/lib/tasks/errors.mjs";

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

test("sanitizeAdapterFailure publishes an actionable whitelisted reason without transport detail", () => {
  const missingBinary = sanitizeAdapterFailure({
    code: "ADAPTER_UNAVAILABLE",
    data: { reason: "binary_not_found", path: "C:\\Users\\Andy\\.codex\\.sandbox-bin\\codex.exe" },
    message: "no readable codex.exe binary found at C:\\Users\\Andy\\.codex\\.sandbox-bin\\codex.exe",
  });
  assert.equal(missingBinary.reason, "binary_not_found");
  assert.equal(missingBinary.code, "ADAPTER_UNAVAILABLE");
  assert.equal(missingBinary.message, ADAPTER_REASON_MESSAGES.binary_not_found);
  assert.match(missingBinary.message, /tasksAdapters\.<kind>\.binary/);
  assert.doesNotMatch(JSON.stringify(missingBinary), /Users|codex\.exe|sandbox-bin/);

  const noHub = sanitizeAdapterFailure({ code: "ADAPTER_UNAVAILABLE", data: { reason: "no_alive_hub" } });
  assert.equal(noHub.reason, "no_alive_hub");
  assert.equal(noHub.message, ADAPTER_REASON_MESSAGES.no_alive_hub);

  // Unknown reasons stay dropped: a caller cannot smuggle prose (or a path) into a receipt.
  const unknown = sanitizeAdapterFailure({
    code: "ADAPTER_UNAVAILABLE",
    data: { reason: "no_alive_hub at C:\\Users\\Andy\\.gemini" },
  });
  assert.equal(unknown.reason, null);
  assert.equal(unknown.message, ADAPTER_FAILURE_MESSAGES.unavailable);

  const prose = sanitizeAdapterFailure({
    code: "REPORT_INVALID",
    data: { reason: "locator.cascadeId is required for Antigravity inspect" },
  });
  assert.equal(prose.reason, null);
});

test("ADAPTER_OPERATIONS enforces exact 7 operations at both runtime and tsc compile time", () => {
  assert.equal(ADAPTER_OPERATIONS.length, 7);
  for (const op of ADAPTER_OPERATIONS) {
    assert.equal(isAdapterOperation(op), true);
    assert.equal(assertAdapterOperation(op), op);
  }
  for (const badOp of ["destroy", "ping", "", null, 8]) {
    assert.equal(isAdapterOperation(badOp), false);
    assert.throws(
      () => assertAdapterOperation(badOp),
      (err) => isTaskError(err, TASK_ERROR.INVALID_ADAPTER),
    );
  }

  const repoRoot = resolve(import.meta.dirname, "..");
  const configPath = resolve(repoRoot, "tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    repoRoot,
  );
  const virtualFile = resolve(repoRoot, "src/lib/adapters/__typecheck_probe__.mts");
  const badSource = `
import type { RuntimeAdapter } from "./base.mjs";
const forged: RuntimeAdapter = {
  probe: async () => ({ ok: true, elapsedMs: 0 }),
  start: async () => ({ accepted: true, locator: {} }),
  inspect: async () => ({ state: "progress" }),
  sendInput: async () => ({ accepted: true }),
  cancel: async () => ({ requestAccepted: true }),
  events: async () => ({ events: [], nextCursor: 0 }),
  decideApproval: async () => ({ accepted: true }),
  forgedEighthOp: async () => ({}),
};
void forged;
`;
  const host = ts.createCompilerHost(parsed.options);
  const origGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    if (resolve(fileName) === virtualFile) {
      return ts.createSourceFile(fileName, badSource, languageVersion);
    }
    return origGetSourceFile(fileName, languageVersion, ...rest);
  };
  const program = ts.createProgram([virtualFile], parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(virtualFile));
  assert.ok(diagnostics.length > 0, "tsc must reject a forged 8th adapter operation");
  assert.ok(
    diagnostics.some((d) => d.code === 2353 && String(d.messageText).includes("forgedEighthOp")),
    `expected TS2353 mentioning forgedEighthOp, got: ${diagnostics.map((d) => `${d.code}:${d.messageText}`).join("; ")}`,
  );
});
