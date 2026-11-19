export interface StatsMethodEntry {
  count: number;
  errors: number;
  lastMs: number | null;
  lastAt: string | null;
}

export interface StatsRecentEntry {
  method: string;
  ms: number;
  ok: boolean;
  code: number | null;
  at: string;
}

export interface StatsSnapshot {
  total: number;
  errors: number;
  lastCallAt: string | null;
  lastErrorAt: string | null;
  outcomes: {
    timeouts: number;
    cancelledByClient: number;
  };
  approvals: {
    denied: number;
    allowed: number;
  };
  byMethod: Record<string, StatsMethodEntry>;
  recent: StatsRecentEntry[];
}

export interface StatsTracker {
  readonly startedAt: number;
  readonly pid: number;
  recordApproval(outcome?: "denied" | "allowed" | string): void;
  record(
    method: string,
    ms: number,
    ok: boolean,
    code?: number | null,
    outcome?: string | null,
  ): void;
  snapshot(): StatsSnapshot;
}

export declare function createStats(options?: {
  startedAt?: number;
  pid?: number;
  ring?: number;
}): StatsTracker;
