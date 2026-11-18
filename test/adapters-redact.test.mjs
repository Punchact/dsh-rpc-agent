import assert from "node:assert/strict";
import test from "node:test";

import { redactDeep, redactSecrets } from "../lib/adapters/redact.mjs";

test("redactSecrets redacts Bearer, GitHub, sk- keys, and CSRF tokens while truncating safely", () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), null);
  assert.equal(redactSecrets(12345), null);
  assert.equal(redactSecrets({ a: 1 }), null);

  const plain = "normal execution output without credentials";
  assert.equal(redactSecrets(plain), plain);

  const input = [
    "auth Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
    "gh ghp_1234567890abcdefghij1234",
    "api sk-proj_abcdef1234567890xyz",
    "hdr x-codeium-csrf-token: csrf-hdr-secret-99",
    'json "csrfToken": "csrf-json-secret-88"',
  ].join(" | ");

  const redacted = redactSecrets(input);
  assert.doesNotMatch(redacted, /eyJhbGciOiJIUzI1NiJ9|ghp_1234|sk-proj_|csrf-hdr-secret-99|csrf-json-secret-88/);
  assert.equal(redacted.match(/\[redacted\]/g).length, 5);

  const long = "a".repeat(2050);
  const clipped = redactSecrets(long, { maxChars: 2000 });
  assert.ok(clipped.startsWith("a".repeat(2000)));
  assert.ok(clipped.endsWith("… (truncated)"));
});

test("redactDeep redacts sensitive keys, nested strings, and enforces depth limit 6", () => {
  const obj = {
    token: "plain-token-value",
    apiSecret: "should-be-hidden",
    dbPassword: "pw",
    authorizationHeader: "Bearer xyz123",
    nested: {
      note: "failed with sk-1234567890abcdef12",
      arr: ["ghp_abcdefghijklmnopqrstuvwxyz", { ok: 42 }],
    },
  };
  const out = redactDeep(obj);
  assert.equal(out.token, "[redacted]");
  assert.equal(out.apiSecret, "[redacted]");
  assert.equal(out.dbPassword, "[redacted]");
  assert.equal(out.authorizationHeader, "[redacted]");
  assert.equal(out.nested.note, "failed with [redacted]");
  assert.equal(out.nested.arr[0], "[redacted]");
  assert.deepEqual(out.nested.arr[1], { ok: 42 });

  // Depth limit 6 stops recursion beyond level 5 -> 6
  const deep = { a: { b: { c: { d: { e: { f: { g: "too-deep" } } } } } } };
  const clipped = redactDeep(deep);
  assert.equal(clipped.a.b.c.d.e.f, "[truncated: depth]");
});


test("redactSecrets covers Basic auth, cookies, URL userinfo, GitHub PATs and AWS keys", () => {
  const input = [
    "authorization: Basic dXNlcjpwYXNzd29yZA==",
    "cookie: session=abc123; csrftoken=zzz",
    "fetch https://deploy:hunter2@registry.example/v1",
    "pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "aws AKIAIOSFODNN7EXAMPLE",
  ].join(" | ");

  const redacted = redactSecrets(input);
  assert.doesNotMatch(redacted, /dXNlcjpwYXNzd29yZA|session=abc123|hunter2|github_pat_11ABCDEFG|AKIAIOSFODNN7EXAMPLE/);
  assert.ok(redacted.includes("registry.example/v1"));
});

test("redactDeep leaves token budgets alone and only redacts string credentials", () => {
  const out = redactDeep({
    maxTokens: 4096,
    tokenCount: 12,
    totalTokens: 99,
    tokenLimit: 200,
    token: "real-secret-value",
    refresh_token: "another-secret",
    csrfToken: "csrf-1",
    headers: { "x-codeium-csrf-token": "hdr-secret" },
  });

  // Numbers are budgets, not credentials: clobbering them hides real cost data.
  assert.equal(out.maxTokens, 4096);
  assert.equal(out.tokenCount, 12);
  assert.equal(out.totalTokens, 99);
  assert.equal(out.tokenLimit, 200);
  // Strings under credential keys still go.
  assert.equal(out.token, "[redacted]");
  assert.equal(out.refresh_token, "[redacted]");
  assert.equal(out.csrfToken, "[redacted]");
  assert.equal(out.headers["x-codeium-csrf-token"], "[redacted]");
});
