import assert from "node:assert/strict";
import test from "node:test";

import { CARD_VERSION, CONTROL_NAMES, hashCard, normalizeCard, withVerified } from "../lib/agents/card.mjs";
import { TASK_ERROR, isTaskError } from "../lib/tasks/errors.mjs";

function validCard(overrides = {}) {
  return {
    identity: {
      agentId: "ag-codex-1",
      name: "Codex Local",
      kind: "codex-app-server",
      version: "0.169.0",
    },
    controls: {
      start: { support: "required", evidence: "thread/start + turn/start" },
      steer: { support: "optional", evidence: "turn/steer" },
      cancel: { support: "required", evidence: "turn/interrupt" },
      inspect: { support: "optional", evidence: "thread/read" },
      approval: { support: "optional", evidence: "approval server-request" },
      events: { support: "required", evidence: "stdio json-rpc notifications" },
    },
    limits: { maxConcurrent: 1, maxRuntimeMs: 600_000, maxInputChars: 50_000 },
    limitations: ["requires local WindowsApps codex.exe"],
    ...overrides,
  };
}

test("normalizeCard returns canonical card with declared=true and verified=false even if input claims verified=true", () => {
  const card = normalizeCard(validCard({ declared: false, verified: true }));
  assert.equal(card.cardVersion, CARD_VERSION);
  assert.equal(card.declared, true);
  assert.equal(card.verified, false);
  assert.deepEqual(Object.keys(card.controls), [...CONTROL_NAMES]);

  // A17: a card must name at least one known weakness; advertising only is not a declaration
  assert.throws(
    () => normalizeCard(validCard({ limitations: [] })),
    (err) => err?.data?.kind === "INVALID_CARD" && err?.data?.path === "limitations",
  );
  assert.throws(
    () => normalizeCard(validCard({ limitations: ["   "] })),
    (err) => err?.data?.kind === "INVALID_CARD",
  );
});

test("normalizeCard rejects every invalid shape with INVALID_CARD", () => {
  const badCases = [
    null,
    "not-an-object",
    validCard({ cardVersion: "wrong@2" }),
    validCard({ identity: undefined }),
    validCard({ identity: { agentId: "", name: "x", kind: "k", version: "1" } }),
    validCard({ controls: undefined }),
    (() => {
      const c = validCard();
      delete c.controls.cancel;
      return c;
    })(),
    (() => {
      const c = validCard();
      c.controls.bogus = { support: "optional", evidence: "x" };
      return c;
    })(),
    (() => {
      const c = validCard();
      c.controls.cancel = { support: "maybe", evidence: "x" };
      return c;
    })(),
    (() => {
      const c = validCard();
      c.controls.cancel = { support: "required", evidence: 123 };
      return c;
    })(),
    validCard({ limits: { maxConcurrent: 0 } }),
    validCard({ limits: { unknownLimit: 10 } }),
    (() => {
      const c = validCard();
      delete c.limitations;
      return c;
    })(),
    validCard({ limitations: "not-an-array" }),
    validCard({ limitations: ["ok", 42] }),
  ];

  for (const bad of badCases) {
    assert.throws(
      () => normalizeCard(bad),
      (err) => isTaskError(err, TASK_ERROR.INVALID_CARD),
    );
  }
});

test("hashCard is deterministic regardless of object key order", () => {
  const c1 = normalizeCard(validCard());
  const c2 = {
    verified: c1.verified,
    limitations: [...c1.limitations],
    capabilities: [...c1.capabilities],
    limits: { maxInputChars: 50_000, maxConcurrent: 1, maxRuntimeMs: 600_000 },
    controls: {
      events: c1.controls.events,
      approval: c1.controls.approval,
      inspect: c1.controls.inspect,
      cancel: c1.controls.cancel,
      steer: c1.controls.steer,
      start: c1.controls.start,
    },
    identity: {
      version: c1.identity.version,
      kind: c1.identity.kind,
      name: c1.identity.name,
      agentId: c1.identity.agentId,
    },
    declared: c1.declared,
    cardVersion: c1.cardVersion,
  };

  assert.equal(hashCard(c1), hashCard(c2));
});

test("withVerified keeps a partially probed card at partial, preserves declared support, merges evidence, and lists unsettled controls", () => {
  const base = normalizeCard(
    validCard({
      controls: {
        start: { support: "required", evidence: "declared start" },
        steer: { support: "optional", evidence: "declared steer" },
        cancel: { support: "unsupported", evidence: "declared unsupported" },
        inspect: { support: "optional", evidence: "declared inspect" },
        approval: { support: "unsupported", evidence: "declared no approval" },
        events: { support: "required", evidence: "declared events" },
      },
    }),
  );

  const verified = withVerified(base, { start: true, inspect: true, events: true }, [
    "probe:start=ok",
    "probe:events=ok",
  ]);

  assert.equal(base.verified, false, "input card must not be mutated");
  // start/inspect/events answered, steer did not; cancel/approval are declared
  // unsupported so they are excluded from the settlement test entirely.
  assert.equal(verified.verified, false);
  assert.equal(verified.partial, true);
  assert.deepEqual(verified.verifiedControls, ["start", "inspect", "events"]);
  assert.equal(verified.controls.cancel.support, "unsupported", "declared support stays untouched");
  assert.equal(verified.controls.steer.support, "optional", "declared support stays untouched");
  assert.deepEqual(verified.unknown, ["steer"]);
  assert.deepEqual(verified.evidence, ["probe:start=ok", "probe:events=ok"]);
});

test("withVerified marks the card verified only when every probe-able control answered", () => {
  const base = normalizeCard(
    validCard({
      controls: {
        start: { support: "required", evidence: "live:start" },
        steer: { support: "optional", evidence: "live:steer" },
        cancel: { support: "required", evidence: "live:cancel" },
        inspect: { support: "optional", evidence: "live:inspect" },
        approval: { support: "unsupported", evidence: "no approval channel" },
        events: { support: "required", evidence: "live:events" },
      },
    }),
  );

  const partial = withVerified(base, { start: true, steer: true, cancel: true, inspect: true, events: false }, []);
  assert.equal(partial.verified, false);
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.unknown, ["events"]);

  const full = withVerified(
    base,
    { start: true, steer: true, cancel: true, inspect: true, events: true },
    ["probe:all=ok"],
  );
  assert.equal(full.verified, true, "approval is declared unsupported, so five settled controls is complete");
  assert.equal(full.partial, false);
  assert.deepEqual(full.unknown, []);
  assert.equal(full.controls.approval.verified, false);
  assert.equal(full.controls.start.verified, true);
});
