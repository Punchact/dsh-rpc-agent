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

const SYSTEM_ERRNO = /^E[A-Z0-9]+$/;

// Only the undici codes whose socket-level meaning is unambiguous. Anything
// else is reported verbatim rather than guessed at.
const UNDICI_CODE_ALIASES = new Map([
  ["UND_ERR_SOCKET", "ECONNRESET"],
  ["UND_ERR_CLOSED", "ECONNRESET"],
  ["UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"],
  ["UND_ERR_HEADERS_TIMEOUT", "ETIMEDOUT"],
  ["UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"],
]);

const MAX_DEPTH = 6;

export function collectErrorCodes(error, out = [], depth = 0) {
  if (!error || typeof error !== "object" || depth > MAX_DEPTH) return out;
  if (typeof error.code === "string" && error.code.length > 0) out.push(error.code);
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) collectErrorCodes(nested, out, depth + 1);
  }
  if (error.cause) collectErrorCodes(error.cause, out, depth + 1);
  return out;
}

export function transportCode(error) {
  const codes = collectErrorCodes(error);
  // A real errno always wins: it is the most specific thing in the chain.
  const system = codes.find((code) => SYSTEM_ERRNO.test(code));
  if (system) return system;
  const alias = codes.map((code) => UNDICI_CODE_ALIASES.get(code)).find(Boolean);
  return alias ?? codes[0];
}
