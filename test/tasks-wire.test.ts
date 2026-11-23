import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveConfig } from "../dist/lib/config.mjs";
import { wireTaskCentre } from "../dist/lib/tasks/wire.mjs";

// The wire module ships as JavaScript, so its interface types are erased at build time.
// Derive the host-context shape from the function signature instead of importing a type.
type WireCtx = Parameters<typeof wireTaskCentre>[0]["ctx"];
type ProbeMap = Record<string, (() => Promise<boolean>) | undefined>;
type AgentRow = Parameters<Awaited<ReturnType<typeof wireTaskCentre>>["agentProbes"]>[0];

function makeWireCtx(): {
  ctx: WireCtx;
  warnings: string[];
  effects: Array<{ label: string | undefined; dispose: () => unknown }>;
} {
  const warnings: string[] = [];
  const effects: Array<{ label: string | undefined; dispose: () => unknown }> = [];
  const rawCtx = {
    sessionController: {
      follow: async function* () {},
      create: async () => ({ sessionId: "s-1" }),
      prompt: async () => ({}),
      cancel: async () => ({ accepted: true, stopped: true }),
      list: async () => ({ items: [] }),
    },
    logger: {
      info: () => {},
      warn: (m: string) => warnings.push(m),
      error: () => {},
      debug: () => {},
    },
    get: () => undefined,
    on: () => {},
    effect(fn: () => void, label?: string) {
      const dispose = fn();
      if (typeof dispose === "function") effects.push({ label, dispose });
    },
  };
  return { ctx: rawCtx as unknown as WireCtx, warnings, effects };
}

function makeAgentRow(adapterKind: string): AgentRow {
  return {
    agent_id: `ag-${adapterKind}`,
    kind: adapterKind,
    adapter_kind: adapterKind,
    project_id: null,
    manifest_revision: null,
    card_json: "{}",
    card_hash: "hash",
    adapter_config_json: null,
    adapter_config_ref: null,
    probe_status: "unknown",
    probe_evidence_json: null,
    probe_expires_at: null,
    enabled: 1,
    created_at: "2026-11-23T00:00:00.000Z",
    updated_at: "2026-11-23T00:00:00.000Z",
  };
}

test("wireTaskCentre stays inert and exposes safe agentProbes when tasksEnabled=false", async () => {
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-tasks-wire-off-"));
  process.env.DSH_HOME = home;
  const { ctx, effects } = makeWireCtx();
  try {
    const config = resolveConfig({ tasksEnabled: false, defaultCwd: home });
    const wiring = await wireTaskCentre({
      ctx,
      config,
      approvals: null,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    assert.equal(wiring.store, null);
    assert.equal(wiring.engine, null);
    assert.equal(wiring.dispatcher, null);
    assert.equal(wiring.adapters, null);
    assert.equal(wiring.autopilot, null);
    assert.equal(wiring.status.enabled, false);
    assert.equal(wiring.status.mode, "off");
    assert.equal(wiring.status.ready, false);
    assert.equal(wiring.status.autopilotStats, null);
    assert.equal(effects.length, 0);
    assert.equal(existsSync(join(home, "storages", "task-center", "tasks.db")), false);
    const probes = wiring.agentProbes(makeAgentRow("dsh")) as ProbeMap;
    assert.equal(await probes.start?.(), false);
    await wiring.cleanup();
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("wireTaskCentre wires store, engine, dispatcher, autopilotStats, agentProbes, and cleanup when enabled", async () => {
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-tasks-wire-on-"));
  process.env.DSH_HOME = home;
  const { ctx, effects } = makeWireCtx();
  try {
    const config = resolveConfig({
      tasksEnabled: true,
      tasksAutopilot: true,
      tasksAutopilotIntervalMs: 60000,
      defaultCwd: home,
    });
    const wiring = await wireTaskCentre({
      ctx,
      config,
      approvals: null,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    try {
      assert.ok(wiring.store);
      assert.ok(wiring.engine);
      assert.ok(wiring.dispatcher);
      assert.ok(wiring.adapters?.dsh);
      assert.ok(wiring.autopilot);
      assert.equal(wiring.status.enabled, true);
      assert.equal(wiring.status.mode, "file");
      assert.equal(wiring.status.ready, true);
      assert.equal(wiring.status.seedError, null);
      assert.equal(wiring.status.startError, null);
      assert.deepEqual(wiring.status.autopilot, {
        enabled: true,
        intervalMs: 60000,
        maxStart: 2,
        maxPump: 4,
      });
      assert.deepEqual(wiring.status.autopilotStats, {
        passes: 0,
        lastPassAt: null,
        lastStarted: 0,
        lastPumped: 0,
        lastFailed: 0,
        lastError: null,
      });
      assert.equal(effects.length, 1);
      assert.equal(effects[0]?.label, "dsh-rpc.task-hub");

      const dshProbes = wiring.agentProbes(makeAgentRow("dsh")) as ProbeMap;
      assert.equal(await dshProbes.start?.(), true);
      const missingProbes = wiring.agentProbes(makeAgentRow("codex")) as ProbeMap;
      assert.equal(await missingProbes.start?.(), false);
    } finally {
      await wiring.cleanup();
    }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("wireTaskCentre degrades to mode=failed with startError when opening store fails", async () => {
  const prevHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "dsh-tasks-wire-fail-"));
  process.env.DSH_HOME = home;
  const dirAsDb = join(home, "not-a-file");
  mkdirSync(dirAsDb, { recursive: true });
  const { ctx } = makeWireCtx();
  const warnings: string[] = [];
  try {
    const config = resolveConfig({
      tasksEnabled: true,
      tasksDbPath: dirAsDb,
      defaultCwd: home,
    });
    const wiring = await wireTaskCentre({
      ctx,
      config,
      approvals: null,
      log: { info: () => {}, warn: (m: string) => warnings.push(m), error: () => {}, debug: () => {} },
    });
    assert.equal(wiring.store, null);
    assert.equal(wiring.engine, null);
    assert.equal(wiring.dispatcher, null);
    assert.equal(wiring.adapters, null);
    assert.equal(wiring.autopilot, null);
    assert.equal(wiring.status.enabled, true);
    assert.equal(wiring.status.mode, "failed");
    assert.equal(wiring.status.ready, false);
    const startError = wiring.status.startError as unknown as string | null;
    assert.ok(typeof startError === "string" && startError.length > 0);
    assert.ok(warnings.some((w) => /task center disabled due to startup error/.test(w)));
    await wiring.cleanup();
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
