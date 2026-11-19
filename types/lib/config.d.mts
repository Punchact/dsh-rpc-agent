export declare const MAX_WAIT_SLICE_MS: number;
export declare const MIN_WAIT_SLICE_MS: number;

export interface TaskAdapterConfig {
  enabled?: boolean;
  adapterConfigRef?: string;
  binary?: string;
  projectId?: string;
  model?: string;
  [key: string]: unknown;
}

export interface ResolvedConfig {
  enabled: boolean;
  token?: string;
  tokenFile?: string;
  path: string;
  allowRemote: boolean;
  defaultCwd: string;
  defaultAgentPreset: string;
  defaultTimeoutMs: number;
  historyBudgetMs: number;
  historyBudgetMsRequested?: number;
  maxWaitSliceMs: number;
  maxWaitSliceMsRequested?: number;
  maxBodyBytes: number;
  maxSessions: number;
  logRequests?: boolean;
  traceDefault: string;
  traceDefaultRequested?: string;
  maxResultChars: number;
  timeoutAdvice: boolean;
  approvals: {
    mode: "off" | "deny" | "delegate" | string;
    deadlineMs: number;
  };
  tasksDbPath: string | null;
  tasksProbeTimeoutMs: number;
  tasksPreviewTtlMs: number;
  tasksAdapters: Record<string, TaskAdapterConfig>;
  tasksDispatchMaxSteps: number;
  tasksEnabled: boolean;
  tasksMaxConcurrent: number;
  tasksRequireReconcileOnUnknown: boolean;
  tasksExternalAdapter: string;
  tasksAdapterDebugDetail: boolean;
  tasksAutopilot: boolean;
  tasksAutopilotIntervalMs: number;
  tasksAutopilotMaxStart: number;
  tasksAutopilotMaxPump: number;
}

export interface DescribedConfig {
  enabled: boolean;
  path: string;
  allowRemote: boolean;
  defaultCwd: string | null;
  defaultAgentPreset: string | null;
  defaultTimeoutMs: number;
  historyBudgetMs: number;
  maxWaitSliceMs: number;
  maxWaitSliceMsRequested?: number;
  maxBodyBytes: number;
  maxSessions: number;
  traceDefault: string;
  traceDefaultRequested?: string;
  maxResultChars: number;
  timeoutAdvice: boolean;
  approvals: {
    mode: string;
    deadlineMs: number;
  };
  tasksDbPath: string | null;
  tasksProbeTimeoutMs: number;
  tasksPreviewTtlMs: number;
  tasksAdapters: Record<string, unknown>;
  tasksDispatchMaxSteps: number;
  tasksEnabled: boolean;
  tasksMaxConcurrent: number;
  tasksRequireReconcileOnUnknown: boolean;
  tasksExternalAdapter: string;
  tasksAdapterDebugDetail: boolean;
  tasksAutopilot: boolean;
  tasksAutopilotIntervalMs: number;
  tasksAutopilotMaxStart: number;
  tasksAutopilotMaxPump: number;
}

export declare function resolveConfig(input?: Record<string, unknown>): ResolvedConfig;
export declare function describeConfig(config: Partial<ResolvedConfig>): DescribedConfig;
