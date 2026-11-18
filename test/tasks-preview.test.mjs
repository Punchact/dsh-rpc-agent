import assert from "node:assert/strict";
import test from "node:test";

import { TASK_ERROR, isTaskError } from "../lib/tasks/errors.mjs";
import { createTaskEngine, seedBaselineEntities } from "../lib/tasks/engine.mjs";
import { consumePreview, createPreview } from "../lib/tasks/preview.mjs";
import { openStore } from "../lib/tasks/store.mjs";

async function setup() {
  const store = openStore({ path: ":memory:" });
  await seedBaselineEntities(store, {
    principal: { principalId: "p-owner" },
    workspace: { workspaceId: "ws-1", rootPath: "C:\\ws-1" },
    agent: { agentId: "ag-1", adapterKind: "codex" },
    capabilityRevision: { revisionId: "cap-1", capability: "review.diff@1" },
  });
  await seedBaselineEntities(store, {
    principal: { principalId: "p-other" },
  });
  return { store, engine: createTaskEngine(store) };
}

test("createPreview and consumePreview enforce one-time consumption, digest match, TTL, and ownership", async () => {
  const { store } = await setup();
  try {
    let clock = 1_700_000_000_000;
    const now = () => clock;

    const pv = await createPreview(store, {
      principalId: "p-owner",
      requestDigest: "digest-abc",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
      ttlMs: 5_000,
      now,
    });
    assert.ok(pv.previewId.startsWith("pv_"));

    // Ownership mismatch -> NOT_FOUND without consuming the preview
    await assert.rejects(
      () => consumePreview(store, { previewId: pv.previewId, principalId: "p-other", requestDigest: "digest-abc", now }),
      (err) => isTaskError(err, TASK_ERROR.NOT_FOUND),
    );

    // Digest mismatch -> PREVIEW_MISMATCH without consuming the preview
    await assert.rejects(
      () => consumePreview(store, { previewId: pv.previewId, principalId: "p-owner", requestDigest: "digest-wrong", now }),
      (err) => isTaskError(err, TASK_ERROR.PREVIEW_MISMATCH),
    );

    // First valid consume succeeds
    const consumed = await consumePreview(store, {
      previewId: pv.previewId,
      principalId: "p-owner",
      requestDigest: "digest-abc",
      now,
    });
    assert.equal(consumed.previewId, pv.previewId);
    assert.equal(consumed.agentId, "ag-1");

    // Second consume fails PREVIEW_EXPIRED
    await assert.rejects(
      () => consumePreview(store, { previewId: pv.previewId, principalId: "p-owner", requestDigest: "digest-abc", now }),
      (err) => isTaskError(err, TASK_ERROR.PREVIEW_EXPIRED),
    );

    // TTL expiry fails PREVIEW_EXPIRED
    const pv2 = await createPreview(store, {
      principalId: "p-owner",
      requestDigest: "digest-ttl",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
      ttlMs: 1_000,
      now,
    });
    clock += 1_500;
    await assert.rejects(
      () => consumePreview(store, { previewId: pv2.previewId, principalId: "p-owner", requestDigest: "digest-ttl", now }),
      (err) => isTaskError(err, TASK_ERROR.PREVIEW_EXPIRED),
    );
  } finally {
    store.close();
  }
});

test("engine.submit consumes preview atomically and rejects reused or tampered preview", async () => {
  const { store, engine } = await setup();
  try {
    const pv = await createPreview(store, {
      principalId: "p-owner",
      requestDigest: "digest-submit-1",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
      ttlMs: 60_000,
    });

    // Tampered requestDigest is rejected
    await assert.rejects(
      () =>
        engine.submit({
          principalId: "p-owner",
          idempotencyKey: "bad-digest",
          previewId: pv.previewId,
          requestDigest: "digest-tampered",
        }),
      (err) => isTaskError(err, TASK_ERROR.PREVIEW_MISMATCH),
    );

    // First submit consumes the preview and creates the queued task
    const task = await engine.submit({
      principalId: "p-owner",
      idempotencyKey: "good-submit-1",
      previewId: pv.previewId,
      requestDigest: "digest-submit-1",
    });
    assert.equal(task.status, "queued");
    assert.equal(task.agentId, "ag-1");

    // Idempotent retry with the same idempotencyKey returns the created task
    const replay = await engine.submit({
      principalId: "p-owner",
      idempotencyKey: "good-submit-1",
      previewId: pv.previewId,
      requestDigest: "digest-submit-1",
    });
    assert.equal(replay.taskId, task.taskId);
    assert.equal(replay.deduplicated, true);

    // Different idempotencyKey trying to reuse the consumed preview fails PREVIEW_EXPIRED
    await assert.rejects(
      () =>
        engine.submit({
          principalId: "p-owner",
          idempotencyKey: "second-submit-different-key",
          previewId: pv.previewId,
          requestDigest: "digest-submit-1",
        }),
      (err) => isTaskError(err, TASK_ERROR.PREVIEW_EXPIRED),
    );
  } finally {
    store.close();
  }
});
