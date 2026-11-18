// Outbound secret redaction and bounded recursion helpers for adapter outputs,
// task ledger text fields, and optional debug diagnostics (SEC-2).

const SENSITIVE_KEY_RE = /token|secret|password|authorization/i;
const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_DEPTH = 6;

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /x-codeium-csrf-token:\s*[^\s",}]+/gi,
  /csrfToken["\s:=]+[^\s",}]+/gi,
];

/**
 * Redact known credential patterns from `text` and truncate beyond `maxChars`.
 * Returns `null` when `text` is not a string.
 */
export function redactSecrets(text, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (typeof text !== "string") return null;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS;
  if (out.length > limit) {
    return `${out.slice(0, limit)}… (truncated)`;
  }
  return out;
}

/**
 * Recursively redact credential strings and sensitive keys up to `maxDepth`.
 */
export function redactDeep(value, opts = {}) {
  const maxChars = Number.isInteger(opts?.maxChars) && opts.maxChars > 0 ? opts.maxChars : DEFAULT_MAX_CHARS;
  const maxDepth = Number.isInteger(opts?.maxDepth) && opts.maxDepth >= 0 ? opts.maxDepth : DEFAULT_MAX_DEPTH;

  function walk(node, depth) {
    if (typeof node === "string") {
      return redactSecrets(node, { maxChars });
    }
    if (node === null || typeof node !== "object") {
      return node;
    }
    if (depth >= maxDepth) {
      return "[truncated]";
    }
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, depth + 1));
    }
    const out = {};
    for (const [key, val] of Object.entries(node)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = walk(val, depth + 1);
      }
    }
    return out;
  }

  return walk(value, 0);
}
