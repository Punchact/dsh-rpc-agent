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

import type { PumpParams, PumpResult, StartTaskParams, StartTaskResult } from "./dispatch.mjs";
import { TASK_STATES, TERMINAL_STATES, type TaskStatus } from "./state-machine.mjs";

const NON_PUMPED_NON_TERMINAL_STATES: ReadonlySet<string> = new Set([
  "queued",
  "needs_reconcile",
  "review_pending",
]);

/**
 * Statuses the pass may advance. `queued` is started, the rest are pumped.
 */
export const ACTIVE_STATUSES: readonly TaskStatus[] = Object.freeze([
  "dispatching",
  "running",
  "cancel_requested",
  "waiting_input",
  "waiting_approval",
] as const);

{
  const activeSet = new Set<string>(ACTIVE_STATUSES);
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

export interface AutopilotEngine {
  list(params: { status?: TaskStatus | string; limit?: number }): Promise<{
    items?: Array<{ taskId: string; [key: string]: unknown }>;
  }>;
}

export interface AutopilotDispatcher {
  startTask(params: StartTaskParams): Promise<Partial<StartTaskResult> & { task?: { status?: TaskStatus | string | null; stateVersion?: number | null } }>;
  pump(params: PumpParams): Promise<Partial<PumpResult> & { task?: { status?: TaskStatus | string | null; stateVersion?: number | null } }>;
}

export interface AutopilotLogger {
  warn?: (message: string) => void;
  debug?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface CreateAutopilotOptions {
  engine: AutopilotEngine;
  dispatcher: AutopilotDispatcher;
  logger?: AutopilotLogger;
  maxStart?: number;
  maxPump?: number;
  pumpMaxSteps?: number;
  pumpDeadlineMs?: number;
}

export interface AutopilotStartedEntry {
  taskId: string;
  status: TaskStatus | string | null;
  stateVersion: number | null;
}

export interface AutopilotPumpedEntry {
  taskId: string;
  status: TaskStatus | string | null;
  stateVersion: number | null;
}

export interface AutopilotFailedEntry {
  taskId: string | null;
  action: string;
  message: string;
}

export interface AutopilotStepResult {
  skipped: boolean;
  started: AutopilotStartedEntry[];
  pumped: AutopilotPumpedEntry[];
  failed: AutopilotFailedEntry[];
}

export interface Autopilot {
  step(): Promise<AutopilotStepResult>;
  limits: { maxStart: number; maxPump: number };
}

export function createAutopilot({
  engine,
  dispatcher,
  logger = {},
  maxStart = 2,
  maxPump = 4,
  pumpMaxSteps,
  pumpDeadlineMs,
}: CreateAutopilotOptions = {} as CreateAutopilotOptions): Autopilot {
  if (!engine || typeof engine.list !== "function") {
    throw new TypeError("createAutopilot requires an engine with list()");
  }
  if (!dispatcher || typeof dispatcher.startTask !== "function" || typeof dispatcher.pump !== "function") {
    throw new TypeError("createAutopilot requires a dispatcher with startTask() and pump()");
  }

  const startLimit = Number.isInteger(maxStart) && maxStart > 0 ? maxStart : 2;
  const pumpLimit = Number.isInteger(maxPump) && maxPump > 0 ? maxPump : 4;
  let inFlight = false;

  const pumpArgs = (taskId: string): PumpParams => {
    const args: PumpParams = { taskId };
    if (typeof pumpMaxSteps === "number" && Number.isInteger(pumpMaxSteps) && pumpMaxSteps > 0) {
      args.maxSteps = pumpMaxSteps;
    }
    if (typeof pumpDeadlineMs === "number" && Number.isInteger(pumpDeadlineMs) && pumpDeadlineMs > 0) {
      args.deadlineMs = pumpDeadlineMs;
    }
    return args;
  };

  async function step(): Promise<AutopilotStepResult> {
    // A slow adapter must not stack passes on top of each other.
    if (inFlight) return { skipped: true, started: [], pumped: [], failed: [] };
    inFlight = true;
    const started: AutopilotStartedEntry[] = [];
    const pumped: AutopilotPumpedEntry[] = [];
    const failed: AutopilotFailedEntry[] = [];
    try {
      let queued: Array<{ taskId: string; [key: string]: unknown }> = [];
      try {
        // `engine.list` is async (it answers from a read transaction); awaiting is the
        // difference between a pass that starts tasks and one that quietly starts none.
        queued = (await engine.list({ status: "queued", limit: startLimit }))?.items ?? [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push({ taskId: null, action: "list", message: msg });
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
          const msg = err instanceof Error ? err.message : String(err);
          failed.push({ taskId: task.taskId, action: "start", message: msg });
        }
      }

      for (const status of ACTIVE_STATUSES) {
        let page: Array<{ taskId: string; [key: string]: unknown }> = [];
        try {
          page = (await engine.list({ status, limit: pumpLimit }))?.items ?? [];
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failed.push({ taskId: null, action: `list:${status}`, message: msg });
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
            const msg = err instanceof Error ? err.message : String(err);
            failed.push({ taskId: task.taskId, action: `pump:${status}`, message: msg });
          }
        }
      }
    } finally {
      inFlight = false;
    }

    if (failed.length > 0) {
      logger.warn?.(
        `[dsh-rpc] autopilot pass reported ${failed.length} failure(s): ${failed
          .map((f) => `${f.action} ${f.taskId ?? "-"}: ${f.message}`)
          .join("; ")}`,
      );
    }
    return { skipped: false, started, pumped, failed };
  }

  return { step, limits: { maxStart: startLimit, maxPump: pumpLimit } };
}
