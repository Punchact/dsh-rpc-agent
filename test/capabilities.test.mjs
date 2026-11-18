import test from "node:test";
import assert from "node:assert/strict";

import { formatCapabilities, normalizeSections, SECTION_IDS } from "../lib/capabilities.mjs";
import { PLUGIN_VERSION, PROTOCOL_VERSION } from "../lib/version.mjs";

test("formatCapabilities renders exact text for a fixed 3-section input", () => {
  const input = [
    {
      id: "identity",
      status: "ok",
      source: "plugin",
      lines: [
        `plugin: dsh-rpc-agent ${PLUGIN_VERSION} (protocol ${PROTOCOL_VERSION})`,
        "bridge: http://127.0.0.1:9663/dsh-rpc · token: file · uptime: 41m",
      ],
    },
    {
      id: "tools",
      status: "partial",
      source: "tools",
      lines: [
        "37 tools · names only (schemas are not exposed by this host)",
        "pwsh, read, write, edit, glob, grep",
      ],
    },
    {
      id: "plugins",
      status: "unavailable",
      source: "loader",
      reason: "loader is not a service in this host",
    },
  ];

  const { text, structured, shown, missing, truncated } = formatCapabilities(input);

  const expected = [
    `capabilities: dsh-rpc-agent ${PLUGIN_VERSION} · protocol ${PROTOCOL_VERSION} · 3 sections (1 ok · 1 partial · 1 unavailable)`,
    "identity [ok] source: plugin",
    `  plugin: dsh-rpc-agent ${PLUGIN_VERSION} (protocol ${PROTOCOL_VERSION})`,
    "  bridge: http://127.0.0.1:9663/dsh-rpc · token: file · uptime: 41m",
    "tools [partial] source: tools",
    "  37 tools · names only (schemas are not exposed by this host)",
    "  pwsh, read, write, edit, glob, grep",
    "plugins [unavailable] — loader is not a service in this host",
  ].join("\n");

  assert.equal(text, expected);
  assert.equal(truncated, false);
  assert.deepEqual(shown, ["identity", "tools", "plugins"]);
  assert.deepEqual(missing, []);
  assert.equal(structured.counts.ok, 1);
  assert.equal(structured.counts.partial, 1);
  assert.equal(structured.counts.unavailable, 1);
  assert.equal(structured.sections.length, 3);
});

test("formatCapabilities truncates at max_chars and leaves max_chars: 0 uncapped", () => {
  const manyLines = Array.from({ length: 60 }, (_, idx) => `tool_${idx}: description line ${"x".repeat(40)}`);
  const input = [
    {
      id: "tools",
      status: "ok",
      source: "tools",
      lines: manyLines,
    },
  ];

  const capped = formatCapabilities(input, { maxChars: 240 });
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.length <= 240, `length ${capped.text.length} exceeded 240`);
  assert.ok(capped.text.endsWith("… truncated (raise max_chars to see the rest)"));

  const uncapped = formatCapabilities(input, { maxChars: 0 });
  assert.equal(uncapped.truncated, false);
  assert.ok(uncapped.text.length > 240);
  assert.ok(!uncapped.text.includes("… truncated (raise max_chars to see the rest)"));
});

test("formatCapabilities enforces hard ceiling of 40000 chars", () => {
  const huge = Array.from({ length: 1200 }, (_, idx) => `item_${idx} ${"a".repeat(40)}`);
  const capped = formatCapabilities([{ id: "tools", status: "ok", source: "tools", lines: huge }], {
    maxChars: 999999,
  });
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.length <= 40000);
  assert.ok(capped.text.endsWith("… truncated (raise max_chars to see the rest)"));
});

test("normalizeSections handles null, [], [*], subset, duplicates, and unknown ids", () => {
  assert.equal(new Set(SECTION_IDS).size, SECTION_IDS.length);
  assert.equal(SECTION_IDS.length, 8);

  for (const input of [null, undefined, [], ["*"]]) {
    const res = normalizeSections(input);
    assert.deepEqual(res.sections, [...SECTION_IDS]);
    assert.deepEqual(res.missing, []);
    assert.equal(new Set(res.sections).size, res.sections.length);
  }

  const subset = normalizeSections(["mcp", "identity", "mcp", "bogus", "ghost", "bogus"]);
  assert.deepEqual(subset.sections, ["mcp", "identity"]);
  assert.deepEqual(subset.missing, ["bogus", "ghost"]);

  const wildcardWithUnknown = normalizeSections(["*", "bogus"]);
  assert.deepEqual(wildcardWithUnknown.sections, [...SECTION_IDS]);
  assert.deepEqual(wildcardWithUnknown.missing, ["bogus"]);
});
