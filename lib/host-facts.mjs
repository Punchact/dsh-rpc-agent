// Safe host-fact collection for `dsh.capabilities`.
//
// This is the only module that queries optional Host services via `ctx.get(...)`.
// It never reads profile config files (`cordis.patch.yml`), never shells out,
// and wraps every Host call so a missing or throwing service becomes an honest
// `unavailable` / `partial` section instead of an exception.

import { normalizeSections } from "./capabilities.mjs";
import { PLUGIN_NAME, PLUGIN_VERSION, PROTOCOL_VERSION } from "./version.mjs";

const ALLOWED_SERVICES = new Set([
  "permissionPresets",
  "tools",
  "sessions",
  "workspaceRegistry",
  "loader",
]);

const TOOL_NAME_CAP = 40;
const MCP_PREFIX_RE = /^mcp__([^_]+(?:_[^_]+)*?)__/;

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return message.replace(/\r?\n|\r/g, " ").trim() || "unknown error";
}

function formatCompactNames(names, cap = TOOL_NAME_CAP) {
  if (names.length <= cap) return names.join(", ");
  const head = names.slice(0, cap).join(", ");
  return `${head}, … (+${names.length - cap} more)`;
}

function makeGetter(ctx) {
  return function safeGet(name) {
    if (!ALLOWED_SERVICES.has(name)) {
      return { ok: false, reason: `service "${name}" is outside the capability allowlist` };
    }
    if (!ctx || typeof ctx.get !== "function") {
      return { ok: false, reason: `${name} is not a service in this host` };
    }
    try {
      const service = ctx.get(name);
      if (service === undefined || service === null) {
        return { ok: false, reason: `${name} is not a service in this host` };
      }
      return { ok: true, service };
    } catch (error) {
      return { ok: false, reason: `${name} failed: ${errorMessage(error)}` };
    }
  };
}

function collectIdentity({ state }) {
  const endpointUrl =
    typeof state?.endpointUrl === "string" && state.endpointUrl.trim().length > 0
      ? state.endpointUrl.trim()
      : null;
  const tokenSource =
    typeof state?.tokenSource === "string" && state.tokenSource.trim().length > 0
      ? state.tokenSource.trim()
      : "unknown";
  const uptimeMinutes =
    typeof state?.startedAt === "number" && Number.isFinite(state.startedAt)
      ? Math.max(0, Math.floor((Date.now() - state.startedAt) / 60_000))
      : null;

  return {
    id: "identity",
    status: "ok",
    source: "plugin",
    lines: [
      `plugin: ${PLUGIN_NAME} ${PLUGIN_VERSION} (protocol ${PROTOCOL_VERSION})`,
      `bridge: ${endpointUrl ?? "unpublished"} · token: ${tokenSource} · uptime: ${
        uptimeMinutes !== null ? `${uptimeMinutes}m` : "unknown"
      }`,
    ],
    data: {
      plugin: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      endpointUrl,
      tokenSource,
      uptimeMinutes,
    },
  };
}

function collectRuntime() {
  const uptimeMinutes = Math.max(0, Math.floor(process.uptime() / 60));
  const cwd = process.cwd();
  return {
    id: "runtime",
    status: "ok",
    source: "process",
    lines: [
      `node ${process.version} · ${process.platform} ${process.arch} · pid ${process.pid} · uptime ${uptimeMinutes}m`,
      `cwd: ${cwd}`,
    ],
    data: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      cwd,
      uptimeMinutes,
    },
  };
}

async function collectPermissions(safeGet, sessionId) {
  const got = safeGet("permissionPresets");
  if (!got.ok) {
    return { id: "permissions", status: "unavailable", source: "permissionPresets", reason: got.reason };
  }
  const service = got.service;
  if (typeof service.catalog !== "function") {
    return {
      id: "permissions",
      status: "unavailable",
      source: "permissionPresets",
      reason: "permissionPresets exposes no catalog() method",
    };
  }

  let catalog;
  try {
    catalog = await service.catalog();
  } catch (error) {
    return {
      id: "permissions",
      status: "unavailable",
      source: "permissionPresets",
      reason: `permissionPresets.catalog() failed: ${errorMessage(error)}`,
    };
  }

  const defaultPreset = typeof catalog?.defaultPreset === "string" ? catalog.defaultPreset : null;
  if (!Array.isArray(catalog?.options)) {
    return {
      id: "permissions",
      status: "partial",
      source: "permissionPresets",
      lines: ["permissionPresets.catalog() returned no options list"],
      data: { defaultPreset },
    };
  }

  const options = catalog.options.map((option) => {
    const value =
      typeof option?.value === "string" && option.value.trim()
        ? option.value.trim()
        : typeof option?.name === "string" && option.name.trim()
          ? option.name.trim()
          : String(option ?? "");
    return {
      value,
      name: typeof option?.name === "string" ? option.name : value,
    };
  });

  const labels = options.map((option) =>
    option.value === defaultPreset ? `${option.value} (default)` : option.value,
  );
  const lines = [options.length > 0 ? `presets: ${labels.join(", ")}` : "presets: (none declared)"];
  const data = {
    defaultPreset,
    options,
  };

  if (sessionId) {
    let sessionPreset = null;
    if (typeof service.current !== "function") {
      lines.push(`session ${sessionId}: current preset unavailable (current() not exposed)`);
    } else {
      const sessionsGot = safeGet("sessions");
      if (!sessionsGot.ok || typeof sessionsGot.service.get !== "function") {
        lines.push(`session ${sessionId}: current preset unavailable (sessions lookup unavailable)`);
      } else {
        try {
          const session = sessionsGot.service.get(sessionId);
          if (!session) {
            lines.push(`session ${sessionId}: not live`);
          } else {
            const current = service.current(session);
            sessionPreset = typeof current === "string" && current.trim() ? current.trim() : null;
            lines.push(`session ${sessionId}: ${sessionPreset ?? "unset"}`);
          }
        } catch (error) {
          lines.push(`session ${sessionId}: lookup failed (${errorMessage(error)})`);
        }
      }
    }
    data.sessionId = sessionId;
    data.sessionPreset = sessionPreset;
  }

  return {
    id: "permissions",
    status: options.length > 0 ? "ok" : "partial",
    source: "permissionPresets",
    lines,
    data,
  };
}

function readTools(safeGet) {
  const got = safeGet("tools");
  if (!got.ok) {
    return { ok: false, reason: got.reason };
  }
  const service = got.service;

  let raw;
  let namesOnly = false;
  try {
    if (typeof service.schemas === "function") {
      raw = service.schemas();
    } else if (typeof service.definitions === "function") {
      raw = service.definitions();
    } else if (typeof service.list === "function") {
      raw = service.list();
    } else if (typeof service.names === "function") {
      raw = service.names();
      namesOnly = true;
    } else if (Array.isArray(service)) {
      raw = service;
    } else {
      return { ok: false, reason: "tools service exposes no schemas() method" };
    }
  } catch (error) {
    return { ok: false, reason: `tools query failed: ${errorMessage(error)}` };
  }

  if (!Array.isArray(raw)) {
    return { ok: false, reason: "tools service did not return a list" };
  }

  const seen = new Set();
  const names = [];
  let sawStringEntry = false;
  let sawObjectEntry = false;

  for (const item of raw) {
    if (typeof item === "string") {
      sawStringEntry = true;
      const name = item.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    } else if (item && typeof item === "object") {
      sawObjectEntry = true;
      const candidate =
        typeof item.name === "string"
          ? item.name.trim()
          : typeof item.id === "string"
            ? item.id.trim()
            : "";
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        names.push(candidate);
      }
    }
  }

  if (sawStringEntry && !sawObjectEntry) {
    namesOnly = true;
  }

  return { ok: true, names, namesOnly };
}

function collectTools(toolsResult) {
  if (!toolsResult.ok) {
    return { id: "tools", status: "unavailable", source: "tools", reason: toolsResult.reason };
  }
  const { names, namesOnly } = toolsResult;
  const status = namesOnly ? "partial" : "ok";
  const lines = [
    namesOnly
      ? `${names.length} tools · names only (schemas are not exposed by this host)`
      : `${names.length} tools`,
  ];
  if (names.length > 0) {
    lines.push(formatCompactNames(names, TOOL_NAME_CAP));
  }
  return {
    id: "tools",
    status,
    source: "tools",
    lines,
    data: {
      count: names.length,
      namesOnly,
      names: names.slice(0, TOOL_NAME_CAP),
      truncatedCount: Math.max(0, names.length - TOOL_NAME_CAP),
    },
  };
}

function collectMcp(toolsResult) {
  if (!toolsResult.ok) {
    return { id: "mcp", status: "unavailable", source: "tools(mcp__)", reason: toolsResult.reason };
  }

  const groups = new Map();
  let total = 0;

  for (const fullName of toolsResult.names) {
    const match = MCP_PREFIX_RE.exec(fullName);
    if (!match) continue;
    const prefix = match[1];
    const shortName = fullName.slice(match[0].length) || fullName;
    let bucket = groups.get(prefix);
    if (!bucket) {
      bucket = [];
      groups.set(prefix, bucket);
    }
    bucket.push({ full: fullName, short: shortName });
    total += 1;
  }

  if (groups.size === 0) {
    return {
      id: "mcp",
      status: "unavailable",
      source: "tools(mcp__)",
      reason:
        "no callable mcp__* tools exposed to this agent " +
        "(these are the MCP tools exposed to this agent, not the servers in the profile)",
    };
  }

  const lines = [
    `${total} callable tools across ${groups.size} prefix(es) — ` +
      "these are the MCP tools exposed to this agent, not the servers in the profile",
  ];

  let remaining = TOOL_NAME_CAP;
  let omittedOther = 0;

  for (const [prefix, items] of groups.entries()) {
    if (remaining > 0) {
      const shown = items.slice(0, remaining);
      const rest = items.length - shown.length;
      remaining -= shown.length;
      const suffix = rest > 0 ? `, … (+${rest} more)` : "";
      lines.push(`${prefix} (${items.length}): ${shown.map((entry) => entry.short).join(", ")}${suffix}`);
    } else {
      omittedOther += items.length;
    }
  }

  if (omittedOther > 0) {
    lines.push(`… (+${omittedOther} more MCP tools in additional prefixes)`);
  }

  const servers = Object.fromEntries(
    [...groups.entries()].map(([prefix, items]) => [prefix, items.map((entry) => entry.full)]),
  );

  return {
    id: "mcp",
    status: "ok",
    source: "tools(mcp__)",
    lines,
    data: {
      total,
      serverCount: groups.size,
      servers,
    },
  };
}

function collectSessions(safeGet, sessionId) {
  const got = safeGet("sessions");
  if (!got.ok) {
    return { id: "sessions", status: "unavailable", source: "sessions", reason: got.reason };
  }
  const service = got.service;

  let count = null;
  try {
    if (typeof service.size === "number") {
      count = service.size;
    } else if (typeof service.count === "function") {
      const value = service.count();
      if (typeof value === "number" && Number.isFinite(value)) count = value;
    } else if (typeof service.list === "function") {
      const items = service.list();
      if (Array.isArray(items)) count = items.length;
    } else if (typeof service.values === "function") {
      count = [...service.values()].length;
    } else if (typeof service.keys === "function") {
      count = [...service.keys()].length;
    } else if (Array.isArray(service)) {
      count = service.length;
    }
  } catch (error) {
    return {
      id: "sessions",
      status: "unavailable",
      source: "sessions",
      reason: `sessions query failed: ${errorMessage(error)}`,
    };
  }

  const hasLookup = typeof service.get === "function";
  if (count === null && !hasLookup) {
    return {
      id: "sessions",
      status: "unavailable",
      source: "sessions",
      reason: "sessions service exposes no count or lookup method",
    };
  }

  const status = count === null ? "partial" : "ok";
  const lines = [
    count === null
      ? "live session count is not exposed by this host (only lookup by id is available)"
      : `live sessions: ${count}`,
  ];
  const data = { count };

  if (sessionId) {
    let caller = null;
    if (hasLookup) {
      try {
        const session = service.get(sessionId);
        if (session && typeof session === "object") {
          const cwd = session.header?.cwd ?? session.cwd ?? null;
          const agentPreset = session.header?.agentPreset ?? session.agentPreset ?? null;
          caller = {
            id: session.id ?? sessionId,
            cwd: typeof cwd === "string" ? cwd : null,
            agentPreset: typeof agentPreset === "string" ? agentPreset : null,
          };
        }
      } catch (error) {
        lines.push(`session ${sessionId}: lookup failed (${errorMessage(error)})`);
      }
    }
    if (caller) {
      const parts = [
        "live",
        caller.cwd ? `cwd ${caller.cwd}` : null,
        caller.agentPreset ? `preset ${caller.agentPreset}` : null,
      ].filter(Boolean);
      lines.push(`session ${sessionId}: ${parts.join(" · ")}`);
    } else if (!lines.some((line) => line.startsWith(`session ${sessionId}:`))) {
      lines.push(`session ${sessionId}: not live`);
    }
    data.sessionId = sessionId;
    data.caller = caller;
  }

  return {
    id: "sessions",
    status,
    source: "sessions",
    lines,
    data,
  };
}

function collectWorkspace(safeGet) {
  const got = safeGet("workspaceRegistry");
  if (!got.ok) {
    return { id: "workspace", status: "unavailable", source: "workspaceRegistry", reason: got.reason };
  }
  const service = got.service;
  if (typeof service.list !== "function") {
    return {
      id: "workspace",
      status: "unavailable",
      source: "workspaceRegistry",
      reason: "workspaceRegistry exposes no list() method",
    };
  }

  let raw;
  try {
    raw = service.list();
  } catch (error) {
    return {
      id: "workspace",
      status: "unavailable",
      source: "workspaceRegistry",
      reason: `workspaceRegistry.list() failed: ${errorMessage(error)}`,
    };
  }

  if (!Array.isArray(raw)) {
    return {
      id: "workspace",
      status: "partial",
      source: "workspaceRegistry",
      lines: ["workspaceRegistry.list() did not return an array"],
      data: { count: 0, items: [] },
    };
  }

  const items = raw.map((workspace) => ({
    id: typeof workspace?.id === "string" ? workspace.id : null,
    title: typeof workspace?.title === "string" ? workspace.title : null,
    path: typeof workspace?.path === "string" ? workspace.path : null,
  }));

  const lines = [`${items.length} workspace(s)`];
  const shownItems = items.slice(0, TOOL_NAME_CAP);
  for (const item of shownItems) {
    const label = item.title ? `${item.id ?? "?"} (${item.title})` : (item.id ?? "?");
    lines.push(`${label}: ${item.path ?? "(no path)"}`);
  }
  if (items.length > TOOL_NAME_CAP) {
    lines.push(`… (+${items.length - TOOL_NAME_CAP} more)`);
  }

  return {
    id: "workspace",
    status: "ok",
    source: "workspaceRegistry",
    lines,
    data: {
      count: items.length,
      items: shownItems,
      truncatedCount: Math.max(0, items.length - TOOL_NAME_CAP),
    },
  };
}

function collectPlugins(safeGet) {
  const got = safeGet("loader");
  if (!got.ok) {
    return { id: "plugins", status: "unavailable", source: "loader", reason: got.reason };
  }
  const service = got.service;
  if (typeof service.entries !== "function") {
    return {
      id: "plugins",
      status: "unavailable",
      source: "loader",
      reason: "loader exposes no entries() method",
    };
  }

  let rawEntries;
  try {
    rawEntries = [...service.entries()];
  } catch (error) {
    return {
      id: "plugins",
      status: "unavailable",
      source: "loader",
      reason: `loader.entries() failed: ${errorMessage(error)}`,
    };
  }

  const names = [];
  for (const entry of rawEntries) {
    let name = null;
    if (Array.isArray(entry) && entry.length >= 2) {
      const value = entry[1];
      name = value?.name ?? value?.options?.name ?? value?.id ?? entry[0];
    } else if (entry && typeof entry === "object") {
      name = entry.name ?? entry.options?.name ?? entry.id;
    } else if (typeof entry === "string") {
      name = entry;
    }
    if (typeof name === "string" && name.trim()) {
      names.push(name.trim());
    }
  }

  const lines = [`${names.length} plugin(s)`];
  if (names.length > 0) {
    lines.push(formatCompactNames(names, TOOL_NAME_CAP));
  }

  return {
    id: "plugins",
    status: "ok",
    source: "loader",
    lines,
    data: {
      count: names.length,
      names: names.slice(0, TOOL_NAME_CAP),
      truncatedCount: Math.max(0, names.length - TOOL_NAME_CAP),
    },
  };
}

/**
 * Collect capability facts for the requested sections without throwing.
 */
export async function collectFacts({ ctx, config = {}, state = {}, sessionId = null, sections = null } = {}) {
  const { sections: wanted } = normalizeSections(sections);
  if (wanted.length === 0) return [];

  const safeGet = makeGetter(ctx);
  const callerSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;

  // Read `tools` at most once even when both `tools` and `mcp` are requested.
  let cachedTools = null;
  const getToolsResult = () => {
    if (cachedTools === null) cachedTools = readTools(safeGet);
    return cachedTools;
  };

  const results = [];
  for (const id of wanted) {
    switch (id) {
      case "identity":
        results.push(collectIdentity({ config, state }));
        break;
      case "runtime":
        results.push(collectRuntime());
        break;
      case "permissions":
        results.push(await collectPermissions(safeGet, callerSessionId));
        break;
      case "tools":
        results.push(collectTools(getToolsResult()));
        break;
      case "mcp":
        results.push(collectMcp(getToolsResult()));
        break;
      case "sessions":
        results.push(collectSessions(safeGet, callerSessionId));
        break;
      case "workspace":
        results.push(collectWorkspace(safeGet));
        break;
      case "plugins":
        results.push(collectPlugins(safeGet));
        break;
    }
  }
  return results;
}
