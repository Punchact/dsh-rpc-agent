export declare const APPROVAL_STATE_VERSION: number;
export declare const STATE_TTL_MS: number;
export declare const MAX_STATE_SESSIONS: number;
export declare const MAX_PENDING_ALLOWANCES: number;

export declare function approvalStatePath(env?: Record<string, string | undefined>): string;

export interface ApprovalStateLogger {
  warn?: (message: string) => void;
}

export interface ApprovalState {
  readonly path: string;
  reserveAllowance: (sessionId: string, limit: number) => {
    ok: boolean;
    reservationId?: string;
    used?: number;
  };
  settleAllowance: (sessionId: string, reservationId: string, outcome: string) => boolean;
  allowances: Map<string, number>;
  widened: Map<string, string>;
  owned: {
    get(sessionId: string): number | undefined;
    has(sessionId: string): boolean;
    set(sessionId: string, stamp?: number): unknown;
    delete(sessionId: string): boolean;
    readonly size: number;
    keys(): IterableIterator<string>;
  };
  pendingWidens(): Array<{ sessionId: string; previous: string }>;
  prune(): void;
}

export declare function createApprovalState(options?: {
  file?: string;
  log?: ApprovalStateLogger | null;
  now?: () => number;
}): ApprovalState;
