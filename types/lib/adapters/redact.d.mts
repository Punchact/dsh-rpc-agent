export declare function redactSecrets(text: unknown, opts?: { maxChars?: number }): string | null;
export declare function redactDeep<T = unknown>(
  value: T,
  opts?: { maxChars?: number; maxDepth?: number },
): unknown;
