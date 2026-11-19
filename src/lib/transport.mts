/**
 * Turn a `fetch` rejection into a code a caller can branch on.
 *
 * `fetch` buries the interesting errno under undici's own vocabulary: a reset
 * connection arrives as TypeError("fetch failed") → cause {code:"UND_ERR_SOCKET"},
 * a refused one can arrive inside an AggregateError (happy eyeballs probes both
 * loopback families), and on Linux a socket that dies mid-flight sometimes
 * carries no system errno at all. The point of this module is that the same
 * failure is named the same way on every platform.
 */

export const SYSTEM_ERRNO: RegExp = /^E[A-Z0-9]+$/;

export type UndiciAliasCode = "ECONNRESET" | "ETIMEDOUT";
export type KnownTransportCode = UndiciAliasCode | "EBADPORT";
export type TransportCode = KnownTransportCode | (string & {}) | undefined;

// Only the undici codes whose socket-level meaning is unambiguous. Anything
// else is reported verbatim rather than guessed at.
export const UNDICI_CODE_ALIASES: ReadonlyMap<string, UndiciAliasCode> = new Map<string, UndiciAliasCode>([
  ["UND_ERR_SOCKET", "ECONNRESET"],
  ["UND_ERR_CLOSED", "ECONNRESET"],
  ["UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"],
  ["UND_ERR_HEADERS_TIMEOUT", "ETIMEDOUT"],
  ["UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"],
]);

const MAX_DEPTH = 6;

export function collectErrorCodes(error: unknown, out: string[] = [], depth = 0): string[] {
  if (!error || typeof error !== "object" || depth > MAX_DEPTH) return out;
  const errObj = error as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof errObj.code === "string" && errObj.code.length > 0) out.push(errObj.code);
  if (Array.isArray(errObj.errors)) {
    for (const nested of errObj.errors) collectErrorCodes(nested, out, depth + 1);
  }
  if (errObj.cause) collectErrorCodes(errObj.cause, out, depth + 1);
  return out;
}

// The ports the fetch standard calls "bad". undici refuses them before a socket
// is ever opened, so the rejection carries a cause whose message is `bad port`
// and no errno at all. This matters here because the bridge does not pick its
// own port: it mounts on the Host's Web server, and a Host that binds 5060 or
// 6667 leaves every out-of-process caller (CLI, MCP bridge) unable to connect
// while the server itself thinks it is healthy.
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set<number>([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

export type NumericPortInput = number | `${number}`;

export function isFetchBlockedPort(value: NumericPortInput): boolean {
  let port: unknown = value;
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) return false;
    port = Number(value);
  }
  return typeof port === "number" && Number.isInteger(port) && FETCH_BLOCKED_PORTS.has(port);
}

/** The `bad port` refusal is the only one with no code anywhere in the chain. */
export function hasBadPortCause(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > MAX_DEPTH) return false;
  const errObj = error as { message?: unknown; errors?: unknown; cause?: unknown };
  if (errObj.message === "bad port") return true;
  if (Array.isArray(errObj.errors) && errObj.errors.some((nested) => hasBadPortCause(nested, depth + 1))) {
    return true;
  }
  return Boolean(errObj.cause) && hasBadPortCause(errObj.cause, depth + 1);
}

export function transportCode(error: unknown): TransportCode {
  const codes = collectErrorCodes(error);
  // A real errno always wins: it is the most specific thing in the chain.
  const system = codes.find((code) => SYSTEM_ERRNO.test(code));
  if (system) return system;
  const alias = codes.map((code) => UNDICI_CODE_ALIASES.get(code)).find(Boolean);
  if (alias) return alias;
  // Naming this one is not a guess about errnos: fetch itself refuses the port,
  // and `undefined` gives a caller nothing to branch on or print. Only apply when
  // no code exists anywhere on the chain so explicit error codes stay intact.
  if (codes.length === 0 && hasBadPortCause(error)) return "EBADPORT";
  return codes[0];
}
