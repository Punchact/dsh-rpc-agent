// The machine side of the task centre: a bounded pass that starts what is due and
// advances what is already moving.
//
// Why this exists: task tools are deliberately the 8 + 3 the plan fixed for MCP, and
// `dispatch` / `pump` are machine-side verbs that an external caller never gets. Without
// someone driving them, a task submitted through MCP sits in `queued` forever — the
// caller cannot move it and the ledger never learns anything. The Host therefore runs
// this pass on a timer: it is the only actor that both can see the ledger and is allowed
// to drive adapters.
//
// Two rules keep it honest:
//   * bounded — every call passes a limit, so a large backlog cannot turn into a storm;
//   * best effort — one task failing to start or pump never stops the others, and the
//     failure is reported rather than swallowed.

import { TASK_STATES, TERMINAL_STATES } from "./state-machine.mjs";

const NON_PUMPED_NON_TERMINAL_STATES = new Set(["queued", "needs_reconcile", "review_pending"]);

/**
 * Statuses the pass may advance. `queued` is started, the rest are pumped.
 * Element domain is `TaskStatus` from `./state-machine.mjs` (validated at load
 * time against `TASK_STATES` and `TERMINAL_STATES` to stay a strict subset).
 * @type {readonly import("./state-machine.mjs").TaskStatus[]}
 */
export const ACTIVE_STATUSES = Object.freeze([
  "dispatching",
  "running",
  "cancel_requested",
  "waiting_input",
  "waiting_approval",
]);

{
  const activeSet = new Set(ACTIVE_STATUSES);
  for (const state of TASK_STATES) {
    const bucketCount =
      (activeSet.has(state) ? 1 : 0) +
      (TERMINAL_STATES.has(state) ? 1 : 0) +
      (NON_PUMPED_NON_TERMINAL_STATES.has(state) ? 1 : 0);
    if (bucketCount !== 1) {
      throw new Error(`ACTIVE_STATUSES partition mismatch for task state "${state}"`);
    }
  }
}

/**
 * @param {object} deps
 * @param {{ list: Function }} deps.engine task engine (`list({status, limit})`)
 * @param {{ startTask: Function, pump: Function }} deps.dispatcher
 * @param {{ warn?: Function, debug?: Function }} [deps.logger]
 * @param {number} [deps.maxStart] queued tasks started per pass
 * @param {number} [deps.maxPump] active tasks pumped per pass, per status
 * @param {number} [deps.pumpMaxSteps]
 * @param {number} [deps.pumpDeadlineMs]
 */
export function createAutopilot({
  engine,
  dispatcher,
  logger = {},
  maxStart = 2,
  maxPump = 4,
  pumpMaxSteps,
  pumpDeadlineMs,
} = {}) {
  if (!engine || typeof engine.list !== "function") {
    throw new TypeError("createAutopilot requires an engine with list()");
  }
  if (!dispatcher || typeof dispatcher.startTask !== "function" || typeof dispatcher.pump !== "function") {
    throw new TypeError("createAutopilot requires a dispatcher with startTask() and pump()");
  }

  const startLimit = Number.isInteger(maxStart) && maxStart > 0 ? maxStart : 2;
  const pumpLimit = Number.isInteger(maxPump) && maxPump > 0 ? maxPump : 4;
  let inFlight = false;

  const pumpArgs = (taskId) => {
    const args = { taskId };
    if (Number.isInteger(pumpMaxSteps) && pumpMaxSteps > 0) args.maxSteps = pumpMaxSteps;
    if (Number.isInteger(pumpDeadlineMs) && pumpDeadlineMs > 0) args.deadlineMs = pumpDeadlineMs;
    return args;
  };

  async function step() {
    // A slow adapter must not stack passes on top of each other.
    if (inFlight) return { skipped: true, started: [], pumped: [], failed: [] };
    inFlight = true;
    const started = [];
    const pumped = [];
    const failed = [];
    try {
      let queued = [];
      try {
        // `engine.list` is async (it answers from a read transaction); awaiting is the
        // difference between a pass that starts tasks and one that quietly starts none.
        queued = (await engine.list({ status: "queued", limit: startLimit }))?.items ?? [];
      } catch (err) {
        failed.push({ taskId: null, action: "list", message: err?.message ?? String(err) });
      }

      for (const task of queued) {
        try {
          const res = await dispatcher.startTask({ taskId: task.taskId });
          started.push({
            taskId: task.taskId,
            status: res?.task?.status ?? null,
            stateVersion: res?.task?.stateVersion ?? null,
          });
        } catch (err) {
          // A start failure is a ledger outcome (the dispatcher records it); the pass
          // only reports that it happened.
          failed.push({ taskId: task.taskId, action: "start", message: err?.message ?? String(err) });
        }
      }

      for (const status of ACTIVE_STATUSES) {
        let page = [];
        try {
          page = (await engine.list({ status, limit: pumpLimit }))?.items ?? [];
        } catch (err) {
          failed.push({ taskId: null, action: `list:${status}`, message: err?.message ?? String(err) });
          continue;
        }
        for (const task of page) {
          try {
            const res = await dispatcher.pump(pumpArgs(task.taskId));
            pumped.push({
              taskId: task.taskId,
              status: res?.task?.status ?? null,
              stateVersion: res?.task?.stateVersion ?? null,
            });
          } catch (err) {
            failed.push({ taskId: task.taskId, action: `pump:${status}`, message: err?.message ?? String(err) });
          }
        }
      }
    } finally {
      inFlight = false;
    }

    if (failed.length > 0) {
      logger.warn?.(`[dsh-rpc] autopilot pass reported ${failed.length} failure(s): ${failed
        .map((f) => `${f.action} ${f.taskId ?? "-"}: ${f.message}`)
        .join("; ")}`);
    }
    return { skipped: false, started, pumped, failed };
  }

  return { step, limits: { maxStart: startLimit, maxPump: pumpLimit } };
}
