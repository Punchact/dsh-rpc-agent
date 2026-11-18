import assert from "node:assert/strict";
import test from "node:test";

import { createProber } from "../lib/agents/probe.mjs";

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
