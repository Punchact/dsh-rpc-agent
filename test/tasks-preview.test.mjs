import assert from "node:assert/strict";
import test from "node:test";

import { TASK_ERROR, isTaskError } from "../dist/lib/tasks/errors.mjs";
import { createTaskEngine, seedBaselineEntities } from "../dist/lib/tasks/engine.mjs";
import { consumePreview, createPreview } from "../dist/lib/tasks/preview.mjs";
import { openStore } from "../dist/lib/tasks/store.mjs";

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

test("preview carries degraded[] for a capability card that cannot cancel", async () => {
  const store = openStore({ path: ":memory:" });
  try {
    await seedBaselineEntities(store, {
      principal: { principalId: "p-owner" },
      workspace: { workspaceId: "ws-card", rootPath: "C:\\ws-card" },
      capabilityRevision: { revisionId: "cap-card", capability: "review.diff@1" },
      agent: {
        agentId: "ag-card",
        adapterKind: "dsh",
        capabilities: {
          cardVersion: "capability-card@1",
          controls: {
            start: { support: "required" },
            steer: { support: "unsupported" },
            cancel: { support: "unsupported" },
            inspect: { support: "optional" },
            events: { support: "required" },
            approval: { support: "optional" },
          },
        },
      },
    });

    const preview = await createPreview(store, {
      principalId: "p-owner",
      requestDigest: "digest-card",
      capabilityRevisionId: "cap-card",
      workspaceId: "ws-card",
      agentId: "ag-card",
    });

    // A preview that promised no degraded controls while the agent cannot stop a
    // task would let a caller believe a cancel is possible; the row must be read
    // with the card, not just the id.
    assert.deepEqual(
      preview.degraded.map((d) => d.control).sort(),
      ["cancel", "steer"],
    );
    assert.match(preview.degraded.find((d) => d.control === "cancel").effect, /needs_reconcile/);
  } finally {
    store.close();
  }
});

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

test("a numeric requestDigest is refused instead of being read as absent", async () => {
  const { store, engine } = await setup();
  try {
    const good = await createPreview(store, {
      principalId: "p-owner",
      requestDigest: "digest-typed-1",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    const submitted = await engine.submit({
      principalId: "p-owner",
      idempotencyKey: "digest-typed-ok",
      previewId: good.previewId,
      requestDigest: "digest-typed-1",
    });
    assert.equal(submitted.status, "queued");

    // The 0.9.4 candidate narrowed the digest to "string or undefined" before
    // validating it, so 123 became "absent" and the preview was consumed without
    // any digest check at all. Invalid input has to stay refused (quality
    // review, 0.9.4 finding 2).
    const bad = await createPreview(store, {
      principalId: "p-owner",
      requestDigest: "digest-typed-2",
      capabilityRevisionId: "cap-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
    });
    await assert.rejects(
      () =>
        engine.submit({
          principalId: "p-owner",
          idempotencyKey: "digest-typed-bad",
          previewId: bad.previewId,
          requestDigest: 123,
        }),
      (error) => {
        assert.equal(isTaskError(error, TASK_ERROR.VALIDATION_FAILED), true);
        assert.match(error.message, /requestDigest/);
        return true;
      },
    );

    const tasks = await engine.list({ principalId: "p-owner" });
    assert.equal(tasks.items.length, 1, "the refused submit must not leave a task behind");
  } finally {
    store.close();
  }
});