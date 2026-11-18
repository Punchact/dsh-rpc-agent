// Outbound secret redaction and bounded recursion helpers for adapter outputs,
// task ledger text fields, and optional debug diagnostics (SEC-2).

// Key names that carry a credential. Substring match (authorizationHeader,
// csrfToken, apiSecret all count), but only a *string* value is a credential:
// maxTokens/tokenCount are budgets, and redacting a number is a lie that hides
// the numbers an operator needs. TOKEN_COUNT_KEY_RE names those exceptions.
const SENSITIVE_KEY_RE = /token|secret|password|passwd|passphrase|authorization|cookie|api[-_]?key|apikey|private[-_]?key|session[-_]?key|credential/i;
const TOKEN_COUNT_KEY_RE = /^(max|min|num|prompt|completion|total|input|output|reasoning|cached)_?tokens?$|^token_?(count|limit|budget)$/i;
const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_DEPTH = 6;

const SECRET_PATTERNS = [
  // A token is one long run of token characters that is not a plain word:
  // "the bearer of bad news" and "Bearer authentication is required" are prose,
  // and redacting them silently destroys the log line.
  /\bBearer\s+(?![A-Za-z]{8,}\s)(?=[A-Za-z0-9._~+/=_-]{8,})[A-Za-z0-9._~+/=_-]+/gi,
  // HTTP Basic credentials and cookies are just as much a credential as a
  // bearer token; leaving them out meant redaction was pattern-lucky.
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  // http://user:pass@host — the userinfo is the credential.
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/gi,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /x-codeium-csrf-token:\s*[^\s",}]+/gi,
  /csrfToken["\s:=]+[^\s",}]+/gi,
];

// A Cookie header is a *list* of credentials, not one. The generic "stop at ;"
// rule masked the first pair and leaked the rest, so cookies get their own rule:
// consume every pair up to a real boundary (quote, brace, comma, newline) but
// keep the header name so a reader still knows what was removed.
const COOKIE_HEADER_RE = /\b((?:set-)?cookie)\b(["']?\s*[:=]\s*["']?)([^\r\n]*)/gi;

/**
 * Redact known credential patterns from `text` and truncate beyond `maxChars`.
 * Returns `null` when `text` is not a string.
 */
export function redactSecrets(text, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (typeof text !== "string") return null;
  // A cookie header is a list of credentials, not one. Mask every pair in the
  // header's remainder but keep the rest of the line: a URL or a field after a
  // cookie is not part of the cookie, and redacting it hides unrelated evidence.
  let out = text.replace(COOKIE_HEADER_RE, (_match, name, separator, rest) => {
    // Rebuild nothing: only the pair values change, so quotes, braces and the
    // "," between JSON members survive exactly as written.
    const masked = rest.replace(/([^=;\s,"]+)=([^;\s,"}]*)/g, (_pair, key) => key + "=[redacted]");
    return name + separator + masked;
  });
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
      // Say which bound was hit; "[truncated]" alone reads like the value was
      // empty rather than one level deeper than we walk.
      return "[truncated: depth]";
    }
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, depth + 1));
    }
    const out = {};
    for (const [key, val] of Object.entries(node)) {
      // Only a string under a credential-ish key is a credential. A number
      // such as maxTokens: 4000 or tokenCount: 12 is a budget, not a secret,
      // and clobbering it hides the very numbers an operator needs.
      const credentialKey =
        SENSITIVE_KEY_RE.test(key) && !TOKEN_COUNT_KEY_RE.test(key) && typeof val === "string";
      if (credentialKey) {
        out[key] = "[redacted]";
      } else {
        out[key] = walk(val, depth + 1);
      }
    }
    return out;
  }

  return walk(value, 0);
}
