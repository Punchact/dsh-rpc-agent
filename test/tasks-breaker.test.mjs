import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatcher } from "../lib/http.mjs";

// The circuit breaker was the one promise of 0.9.0 that the first live smoke
// test caught lying: with tasksEnabled=false the RPC methods were still
// registered, so a caller could submit work into an in-memory store that would
// vanish on restart. A disabled feature has to look disabled.

function fakeMethods(overrides = {}) {
  return {
    ping: () => ({ ok: true }),
    listTasks: () => ({ items: [] }),
    submitTask: () => ({ taskId: "t1" }),
    listAgents: () => ({ items: [] }),
    ...overrides,
  };
}

test("a disabled task centre answers -32601 for the whole family", async () => {
  const dispatch = buildDispatcher(fakeMethods({ tasksEnabled: false }));
  for (const method of ["dsh.tasks.list", "dsh.tasks.submit", "dsh.tasks.resolve", "dsh.agents.list"]) {
    await assert.rejects(
      () => dispatch(method, {}),
      (error) => {
        assert.equal(error.code, -32601, method);
        assert.equal(error.data?.reason, "tasks_disabled", method);
        assert.match(error.message, /tasksEnabled=false/);
        return true;
      },
    );
  }
  // The rest of the bridge keeps working — the breaker is not a blackout.
  assert.deepEqual(await dispatch("dsh.ping", {}), { ok: true });
  assert.deepEqual(await dispatch("ping", {}), { ok: true });
});

test("an enabled task centre reaches the real handlers", async () => {
  const dispatch = buildDispatcher(fakeMethods({ tasksEnabled: true }));
  assert.deepEqual(await dispatch("dsh.tasks.submit", {}), { taskId: "t1" });
  assert.deepEqual(await dispatch("dsh.tasks.list", {}), { items: [] });
  assert.deepEqual(await dispatch("dsh.agents.list", {}), { items: [] });
});
