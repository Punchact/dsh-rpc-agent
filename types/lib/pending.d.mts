export declare const MAX_PENDING: number;

export interface PendingApprovalPacket {
  approvalId: string;
  sessionId?: string;
  toolName?: string;
  callId?: string;
  escalation?: unknown;
  argv?: unknown;
  cwd?: string;
  preset?: string;
  reason?: string;
  createdAt?: unknown;
  expiresAt?: unknown;
  [key: string]: unknown;
}

export interface PendingStoreLogger {
  warn?: (message: string) => void;
}

export interface PendingStore {
  open(
    packet: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): {
    approvalId: string;
    packet: PendingApprovalPacket;
    promise: Promise<{ decision: string; note: string | null }>;
  };
  open(...args: any[]): {
    approvalId: string;
    packet: PendingApprovalPacket;
    promise: Promise<{ decision: string; note: string | null }>;
  };
  resolve(
    approvalId: string,
    decision: "allow-once" | "reject",
    note?: string | null,
  ): {
    resolved?: boolean;
    sessionId?: string | null;
    toolName?: string | null;
  };
  list(sessionId?: string): PendingApprovalPacket[];
  waitForAny(options?: {
    sessionId?: string;
    waitMs?: number;
    signal?: AbortSignal | null;
  }): Promise<{
    pending: PendingApprovalPacket[];
    timedOut: boolean;
    aborted?: boolean;
  }>;
  watch(sessionId: string): {
    promise: Promise<PendingApprovalPacket>;
    cancel(): void;
  };
  size(): number;
  readonly deadlineMs: number;
}

export declare function createPendingStore(options?: {
  deadlineMs?: number;
  now?: () => number;
  log?: PendingStoreLogger | null;
}): PendingStore;
