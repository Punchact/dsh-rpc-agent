import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { formatCapabilities, normalizeSections, SECTION_IDS } from "../dist/lib/capabilities.mjs";
import { PLUGIN_VERSION, PROTOCOL_VERSION } from "../dist/lib/version.mjs";

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

test("capabilities and host-facts export structured TypeScript contracts checked at compile time", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const validProbe = resolve(repoRoot, "src/__caps_valid_probe__.mts");
  const badProbe = resolve(repoRoot, "src/__caps_bad_probe__.mts");

  const validSource = `
import {
  formatCapabilities,
  normalizeSections,
  type CapabilitySectionId,
  type CollectedCapabilitySection,
  type FormattedCapabilities,
} from "./lib/capabilities.mjs";
import { collectFacts } from "./lib/host-facts.mjs";

const _section: CapabilitySectionId = "identity";
const _norm = normalizeSections([_section]);
const _items: CollectedCapabilitySection[] = [{ id: _section, status: "ok", source: "plugin", lines: ["ok"] }];
const _formatted: FormattedCapabilities = formatCapabilities(_items, { maxChars: 1000, missing: _norm.missing });
const _collected: Promise<CollectedCapabilitySection[]> = collectFacts({ sections: ["identity", "runtime"] });
void [_formatted, _collected];
`;

  const badSource = `
import type { CapabilitySectionId } from "./lib/capabilities.mjs";
import { collectFacts } from "./lib/host-facts.mjs";

const badSection: CapabilitySectionId = "nonexistent";
void collectFacts({ sections: [123 as unknown as CapabilitySectionId], sessionId: 42 });
void badSection;
`;

  const configPath = resolve(repoRoot, "tsconfig.json");
  const parsed = ts.readConfigFile(configPath, ts.sys.readFile);
  const cmd = ts.parseJsonConfigFileContent(parsed.config, ts.sys, repoRoot);
  const options = { ...cmd.options, noEmit: true };

  const runProbe = (filePath, content) => {
    const virtualFiles = new Map([[resolve(filePath), content]]);
    const host = ts.createCompilerHost(options, true);
    const origGetSourceFile = host.getSourceFile.bind(host);
    const origFileExists = host.fileExists.bind(host);
    host.fileExists = (p) => virtualFiles.has(resolve(p)) || origFileExists(p);
    host.getSourceFile = (p, lang) => {
      const hit = virtualFiles.get(resolve(p));
      if (hit !== undefined) return ts.createSourceFile(p, hit, lang, true);
      return origGetSourceFile(p, lang);
    };
    host.writeFile = () => {
      throw new Error("unexpected write during in-memory compiler check");
    };
    const program = ts.createProgram([filePath], options, host);
    return ts.getPreEmitDiagnostics(program).filter((d) => d.file && resolve(d.file.fileName) === resolve(filePath));
  };

  assert.deepEqual(
    runProbe(validProbe, validSource).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    [],
  );
  const badDiagnostics = runProbe(badProbe, badSource);
  assert.ok(badDiagnostics.length >= 2, `expected >= 2 compile-time rejections, got ${badDiagnostics.length}`);
});
