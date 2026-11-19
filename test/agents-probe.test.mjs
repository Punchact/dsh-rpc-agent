import assert from "node:assert/strict";
import test from "node:test";

import { createProber, probesFromAdapter } from "../lib/agents/probe.mjs";

test("probeAll records fast boolean true probes in verified and isolates timeouts, throws, and non-true returns", async () => {
  const prober = createProber({
    timeoutMs: 40,
    probes: {
      start: async () => true,
      steer: async () => false,
      cancel: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return true;
      },
      inspect: async () => {
        throw new Error("socket closed");
      },
      events: async () => "ok",
    },
  });

  const res = await prober.probeAll(["start", "steer", "cancel", "inspect", "events", "approval"]);

  assert.deepEqual(res.verified, { start: true });
  assert.equal(typeof res.elapsedMs, "number");
  assert.ok(res.elapsedMs < 130, `expected parallel timeout around 40ms, got ${res.elapsedMs}ms`);

  const byControl = new Map(res.unknown.map((u) => [u.control, u.reason]));
  assert.equal(byControl.get("steer"), "rejected");
  assert.equal(byControl.get("cancel"), "timeout");
  assert.equal(byControl.get("inspect"), "threw:socket closed");
  assert.equal(byControl.get("events"), "rejected");
  assert.equal(byControl.get("approval"), "rejected");
});

test("probesFromAdapter turns one adapter answer into one probe per control, and calls the adapter once", async () => {
  let calls = 0;
  const adapter = {
    async probe() {
      calls += 1;
      return { ok: true, controls: { start: true, steer: true, cancel: false, inspect: true, events: true, approval: false } };
    },
  };

  const probes = probesFromAdapter(adapter);
  const prober = createProber({ probes, timeoutMs: 50 });
  const res = await prober.probeAll(["start", "steer", "cancel", "inspect", "events", "approval"]);

  assert.deepEqual(res.verified, { start: true, steer: true, inspect: true, events: true });
  const byControl = new Map(res.unknown.map((u) => [u.control, u.reason]));
  assert.equal(byControl.get("cancel"), "rejected");
  assert.equal(byControl.get("approval"), "rejected");
  assert.equal(calls, 1, "one probe round must cost one adapter round-trip, not six");
});

test("probesFromAdapter reports unknown instead of throwing when the adapter is missing, fails, or answers ok:false", async () => {
  const cases = [
    ["no adapter", null],
    ["no probe method", { start: async () => true }],
    ["probe throws", { probe: async () => { throw new Error("language server gone"); } }],
    ["ok:false", { probe: async () => ({ ok: false, reason: "unavailable" }) }],
  ];

  for (const [label, adapter] of cases) {
    const prober = createProber({ probes: probesFromAdapter(adapter), timeoutMs: 50 });
    const res = await prober.probeAll(["start", "cancel"]);
    assert.deepEqual(res.verified, {}, label);
    assert.equal(res.unknown.length, 2, label);
    for (const item of res.unknown) assert.equal(item.reason, "rejected", label);
  }
});
