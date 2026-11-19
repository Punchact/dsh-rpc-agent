import type { ApprovalState } from "./approval-state.mjs";
import type { PendingStore } from "./pending.mjs";

export declare const APPROVAL_MODES: readonly ["off", "deny", "delegate"];
export declare const ESCALATION_TARGETS: readonly ["workspace-write", "danger-full-access"];
export declare const MAX_ALLOWANCES_PER_SESSION: number;
export declare const MAX_ARGV_CHARS: number;
export declare const MAX_REASON_CHARS: number;

export declare function escalationOf(args: unknown): string;

export interface ApprovalGateLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface ApprovalGate {
  pre: (...args: unknown[]) => unknown;
  post: (...args: unknown[]) => unknown;
  dispose: () => void;
  recover: () => Promise<{ restored: number; failed: number }>;
  widenedSessions: () => string[];
}

export interface CreateApprovalGateOptions {
  mode?: string;
  isOwned?: (sessionId: string) => boolean;
  onDeny?: () => void;
  onAllow?: () => void;
  applyPreset?: (sessionId: string, preset: string) => Promise<unknown>;
  currentPreset?: (sessionId: string) => string | null;
  store?: PendingStore | null;
  state?: ApprovalState | null;
  log?: ApprovalGateLogger | null;
}

export declare function createApprovalGate(options?: CreateApprovalGateOptions): ApprovalGate | null;
