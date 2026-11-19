import type { TaskStore } from "./store.mjs";
import type { TaskStatus } from "./state-machine.mjs";

export interface DerivedPhase {
  phase: string;
  label: string;
}

export interface TaskDetail {
  taskId: string;
  principalId: string;
  idempotencyKey: string;
  capabilityRevisionId: string;
  workspaceId: string;
  agentId: string;
  previewId: string | null;
  status: TaskStatus;
  stateVersion: number;
  phase: string;
  phaseLabel: string;
  degraded: unknown;
  activeAttemptId: string | null;
  activeAttempt: {
    attemptId: string;
    attemptNo: number;
    status: string;
    locator: unknown;
    startedAt: string | null;
    endedAt: string | null;
    endReason: string | null;
  } | null;
  mandate: unknown;
  pending: {
    attention: unknown[];
    approvals: unknown[];
  };
  artifacts: unknown[];
  lastEvent: { type: string; seq: number } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  [key: string]: unknown;
}

export interface TaskEngine {
  readonly store: TaskStore;
  derivePhase(input: Record<string, unknown>): DerivedPhase;
  submit(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  get(params?: Record<string, unknown>): Promise<TaskDetail>;
  list(params?: Record<string, unknown>): Promise<{
    items: TaskDetail[];
    nextCursor: string | null;
    hasMore: boolean;
  }>;
  events(params?: Record<string, unknown>): Promise<{
    taskId: string;
    events: Array<{
      seq: number;
      type: string;
      at: string;
      attemptId?: string | null;
      data: unknown;
      [key: string]: unknown;
    }>;
    nextAfterSeq: number;
    hasMore: boolean;
  }>;
  cancel(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  decideApproval(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  resolve(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  recordAttemptStart(params?: {
    taskId: string;
    expectedStateVersion: number;
    runtimeLocator: unknown;
    markRunning?: boolean;
  }): Promise<{ attemptId: string; status: TaskStatus | string; stateVersion: number; [key: string]: unknown }>;
  applyReport(params?: {
    taskId: string;
    attemptId?: string | null;
    adapterEventId?: string | null;
    report: Record<string, unknown>;
  }): Promise<{ status: TaskStatus | string; [key: string]: unknown }>;
  input(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  readArtifact(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export declare function createTaskEngine(
  store: TaskStore,
  options?: { defaultPrincipalId?: string },
): TaskEngine;
