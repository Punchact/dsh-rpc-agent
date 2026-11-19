export declare const TIMEOUT_ADVICE: string;

export interface ShouldAdviseTimeoutInput {
  status?: string;
  timedOut?: boolean;
  requestedMs?: number;
  enabled?: boolean;
  alreadyShown?: boolean;
}

export declare function shouldAdviseTimeout(input: ShouldAdviseTimeoutInput | unknown): boolean;
