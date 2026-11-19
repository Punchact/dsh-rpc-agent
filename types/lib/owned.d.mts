export declare const MAX_OWNED: number;
export declare function useOwnedState(state: unknown): void;
export declare function ownedStore(options?: { file?: string }): unknown;
export declare function ownSession(sessionId: string): boolean;
export declare function isOwnedSession(sessionId: string): boolean;
export declare function forgetSession(sessionId: string): boolean;
export declare function ownedSessions(): string[];
export declare function ownedSessionCount(): number;
export declare function resetOwnedSessions(): void;
