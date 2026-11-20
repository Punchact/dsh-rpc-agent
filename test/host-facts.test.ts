import test from "node:test";
import assert from "node:assert/strict";

import { collectFacts } from "../dist/lib/host-facts.mjs";
import { formatCapabilities, SECTION_IDS } from "../dist/lib/capabilities.mjs";
import { buildDispatcher } from "../dist/lib/http.mjs";
import { createMethods } from "../dist/lib/methods.mjs";
import { resolveConfig } from "../dist/lib/config.mjs";
import { PLUGIN_VERSION } from "../dist/lib/version.mjs";

interface SectionFact {
  id: string;
  status: string;
  reason?: string;
  source?: string;
  lines: string[];
  data: { servers?: Record<string, string[]>; [key: string]: unknown };
}

interface CapabilitiesResultView {
  missing: string[];
  truncated: boolean;
  sections: Array<{ id: string }>;
  text: string;
}

const runCollectFacts = collectFacts as unknown as (opts: Record<string, unknown>) => Promise<SectionFact[]>;

function fullServices(): Record<string, unknown> {
  return {
    permissionPresets: {
      async catalog() {
        return {
          defaultPreset: "workspace-write",
          options: [
            { value: "read-only", name: "Read Only" },
            { value: "workspace-write", name: "Workspace Write" },
            { value: "danger-full-access", name: "Danger Full Access" },
          ],
        };
      },
      current(session: { preset?: string } | undefined) {
        return session?.preset ?? null;
      },
    },
    tools: {
      schemas() {
        return [
          { name: "pwsh", description: "Run shell" },
          { name: "read", description: "Read file" },
          { name: "mcp__github__get_me", description: "GitHub me" },
          { name: "mcp__xerj__xerj_search", description: "Xerj search" },
        ];
      },
    },
    sessions: new Map([
      ["s-caller", { id: "s-caller", header: { cwd: "C:/work/proj", agentPreset: "standard" }, preset: "workspace-write", prompt: "SECRET_PROMPT_OTHER" }],
      ["s-other", { id: "s-other", header: { cwd: "C:/other" }, prompt: "DO_NOT_LEAK_THIS_PROMPT" }],
    ]),
    workspaceRegistry: {
      list() {
        return [{ id: "ws-1", title: "Repo", path: "C:/work/proj" }];
      },
    },
    loader: {
      entries() {
        return [
          ["p1", { name: "@punchact/dsh-rpc-agent" }],
          ["p2", { name: "@deepseek-ai/dsh-tools" }],
        ];
      },
    },
  };
}

test("collectFacts returns ok for stubbed services across all 8 sections", async () => {
  const services = fullServices();
  const asked: string[] = [];
  const ctx = {
    get(name: string) {
      asked.push(name);
      return services[name];
    },
  };
  const state = {
    endpointUrl: "http://127.0.0.1:9663/dsh-rpc",
    tokenSource: "file",
    startedAt: Date.now() - 41 * 60_000,
  };

  const facts = await runCollectFacts({ ctx, config: {}, state, sessionId: "s-caller" });
  assert.deepEqual(
    facts.map((s) => s.id),
    [...SECTION_IDS],
  );
  for (const section of facts) {
    assert.equal(section.status, "ok", `expected ${section.id} to be ok, got ${section.status}: ${section.reason}`);
  }
  // `tools` is queried once for both `tools` and `mcp`; `sessions` is queried for `permissions` + `sessions`.
  for (const name of asked) {
    assert.ok(
      ["permissionPresets", "tools", "sessions", "workspaceRegistry", "loader"].includes(name),
      `unexpected service query: ${name}`,
    );
  }

  const formatted = formatCapabilities(facts as never);
  assert.doesNotMatch(formatted.text, /DO_NOT_LEAK_THIS_PROMPT/);
  assert.doesNotMatch(formatted.text, /SECRET_PROMPT_OTHER/);
});

test("collectFacts degrades missing and throwing ctx.get services to unavailable without throwing", async () => {
  const ctx = {
    get(name: string) {
      if (name === "permissionPresets" || name === "loader") return undefined;
      if (name === "tools" || name === "sessions" || name === "workspaceRegistry") {
        throw new Error(`${name} exploded\nwith stack`);
      }
      return undefined;
    },
  };

  const facts = await runCollectFacts({ ctx, config: {}, state: { tokenSource: "env" } });
  const byId = Object.fromEntries(facts.map((s) => [s.id, s]));

  assert.equal(byId.identity.status, "ok");
  assert.equal(byId.runtime.status, "ok");

  assert.equal(byId.permissions.status, "unavailable");
  assert.equal(byId.permissions.reason, "permissionPresets is not a service in this host");

  assert.equal(byId.plugins.status, "unavailable");
  assert.equal(byId.plugins.reason, "loader is not a service in this host");

  assert.equal(byId.tools.status, "unavailable");
  assert.match(byId.tools.reason ?? "", /tools failed: tools exploded/);
  assert.ok(!(byId.tools.reason ?? "").includes("\n"), "unavailable reason must stay single-line");

  assert.equal(byId.mcp.status, "unavailable");
  assert.equal(byId.sessions.status, "unavailable");
  assert.equal(byId.workspace.status, "unavailable");
});

test("mcp section groups mcp__ tools by prefix and excludes non-mcp tools", async () => {
  const ctx = {
    get(name: string) {
      if (name !== "tools") return undefined;
      return {
        schemas() {
          return [
            { name: "mcp__github__get_me" },
            { name: "mcp__xerj__xerj_search" },
            { name: "mcp__my_srv__run_task" },
            { name: "pwsh" },
          ];
        },
      };
    },
  };

  const facts = await runCollectFacts({ ctx, sections: ["tools", "mcp"] });
  const byId = Object.fromEntries(facts.map((s) => [s.id, s]));

  assert.equal(byId.tools.status, "ok");
  assert.equal(byId.mcp.status, "ok");
  assert.equal(byId.mcp.source, "tools(mcp__)");
  assert.deepEqual(byId.mcp.data.servers, {
    github: ["mcp__github__get_me"],
    xerj: ["mcp__xerj__xerj_search"],
    my_srv: ["mcp__my_srv__run_task"],
  });
  const text = byId.mcp.lines.join("\n");
  assert.match(text, /these are the MCP tools exposed to this agent, not the servers in the profile/);
  assert.match(text, /github \(1\): get_me/);
  assert.match(text, /xerj \(1\): xerj_search/);
  assert.match(text, /my_srv \(1\): run_task/);
  assert.doesNotMatch(text, /pwsh/);
});

test("tools names-only becomes partial and mcp with zero mcp__ tools becomes unavailable", async () => {
  const ctx = {
    get(name: string) {
      if (name === "tools") return { names: () => ["pwsh", "read", "write"] };
      return undefined;
    },
  };
  const facts = await runCollectFacts({ ctx, sections: ["tools", "mcp"] });
  const byId = Object.fromEntries(facts.map((s) => [s.id, s]));

  assert.equal(byId.tools.status, "partial");
  assert.match(byId.tools.lines[0], /3 tools · names only/);
  assert.equal(byId.mcp.status, "unavailable");
  assert.match(byId.mcp.reason ?? "", /these are the MCP tools exposed to this agent, not the servers in the profile/);
});

test("sections subset only collects requested sections and only queries needed services", async () => {
  const asked: string[] = [];
  const ctx = {
    get(name: string) {
      asked.push(name);
      if (name === "loader") return { entries: () => [["a", { name: "plugin-a" }]] };
      throw new Error(`should not have been queried: ${name}`);
    },
  };

  const facts = await runCollectFacts({ ctx, sections: ["identity", "plugins"] });
  assert.deepEqual(
    facts.map((s) => s.id),
    ["identity", "plugins"],
  );
  assert.deepEqual(asked, ["loader"]);
  assert.equal(facts[1].status, "ok");
});

test("methods.capabilities works with no live session and does not touch sessionController", async () => {
  const sessionController = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`sessionController.${String(prop)} must not be called`);
      },
    },
  );
  const services = fullServices();
  const methods = createMethods(
    { sessionController: sessionController as never, webServer: { getOrigin: () => "http://127.0.0.1:9663" } as never },
    resolveConfig({ tasksEnabled: true }),
    { get: (name: string) => services[name] },
    { tokenSource: "file", endpointUrl: "http://127.0.0.1:9663/dsh-rpc", startedAt: Date.now() },
  ) as unknown as { capabilities(params: Record<string, unknown>): Promise<CapabilitiesResultView> };

  const result = await methods.capabilities({ sections: ["identity", "mcp", "nope"] });
  assert.deepEqual(result.missing, ["nope"]);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.sections.map((s) => s.id),
    ["identity", "mcp"],
  );
  // Assert against the single source of truth: a hardcoded version string here would
  // silently rot the moment PLUGIN_VERSION is bumped (it did, at 0.9.0).
  const versionPattern = new RegExp(`^capabilities: dsh-rpc-agent ${PLUGIN_VERSION.replace(/\./g, "\\.")} `);
  assert.match(result.text, versionPattern);

  await assert.rejects(
    () => methods.capabilities({ max_chars: 50000 }),
    (error: { code?: number }) => error.code === -32602,
  );

  const dispatch = buildDispatcher(methods as never) as (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<CapabilitiesResultView>;
  const dispatched = await dispatch("dsh.capabilities", { sections: ["identity"] });
  assert.equal(dispatched.sections.length, 1);
  assert.equal(dispatched.sections[0].id, "identity");
});
