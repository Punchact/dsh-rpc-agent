// Manual config resolution. The plugin deliberately exports no `Config` schema,
// so it carries zero runtime and peer dependencies: a bundle that has to be
// installed into a profile must not need `@deepseek-ai/schemastery` to resolve.
// Validation is therefore explicit, and every failure names the offending key.

const DEFAULTS = {
  enabled: true,
  token: "",
  tokenFile: "",
  path: "/dsh-rpc",
  allowRemote: false,
  defaultCwd: "",
  defaultAgentPreset: "",
  defaultTimeoutMs: 10 * 60 * 1000,
  maxBodyBytes: 1024 * 1024,
  maxSessions: 200,
  logRequests: false,
};

export class ConfigError extends Error {
  constructor(problems) {
    super(`invalid dsh-rpc config: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function resolveConfig(input = {}) {
  if (input === null || input === undefined) input = {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigError(["config must be an object"]);
  }

  const problems = [];
  const take = (key, check, message) => {
    const raw = input[key];
    if (raw === undefined) return DEFAULTS[key];
    const value = check(raw);
    if (value === undefined) problems.push(`${key}: ${message}`);
    return value;
  };

  const asBoolean = (raw) => (typeof raw === "boolean" ? raw : undefined);
  const asString = (raw) => (typeof raw === "string" ? raw.trim() : undefined);
  const asPositiveInt = (raw) =>
    Number.isInteger(raw) && raw > 0 ? raw : undefined;

  const config = {
    enabled: take("enabled", asBoolean, "expected a boolean"),
    token: take("token", asString, "expected a string"),
    tokenFile: take("tokenFile", asString, "expected a string"),
    path: take("path", asString, "expected a string"),
    allowRemote: take("allowRemote", asBoolean, "expected a boolean"),
    defaultCwd: take("defaultCwd", asString, "expected a string"),
    defaultAgentPreset: take("defaultAgentPreset", asString, "expected a string"),
    defaultTimeoutMs: take("defaultTimeoutMs", asPositiveInt, "expected a positive integer (milliseconds)"),
    maxBodyBytes: take("maxBodyBytes", asPositiveInt, "expected a positive integer (bytes)"),
    maxSessions: take("maxSessions", asPositiveInt, "expected a positive integer"),
    logRequests: take("logRequests", asBoolean, "expected a boolean"),
  };

  if (typeof config.path === "string") {
    let path = config.path.startsWith("/") ? config.path : `/${config.path}`;
    while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    if (path === "/") problems.push("path: must not be the site root");
    if (/[\s?#]/.test(path)) problems.push("path: must not contain whitespace, '?' or '#'");
    // A dot segment would never match a registered route and can only be a
    // mistake or an attempt to reach outside the mount point.
    if (path.split("/").some((segment) => segment === "." || segment === "..")) {
      problems.push("path: must not contain '.' or '..' segments");
    }
    config.path = path;
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** Public projection: never leak the shared secret through `dsh.ping`. */
export function describeConfig(config) {
  return {
    enabled: config.enabled,
    path: config.path,
    allowRemote: config.allowRemote,
    defaultCwd: config.defaultCwd || null,
    defaultAgentPreset: config.defaultAgentPreset || null,
    defaultTimeoutMs: config.defaultTimeoutMs,
    maxBodyBytes: config.maxBodyBytes,
    maxSessions: config.maxSessions,
  };
}
