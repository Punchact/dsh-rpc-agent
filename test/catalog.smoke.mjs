// Smoke-test the wired catalogue without a Harness: the running instance still
// serves the old module, so this is the closest thing to a live check available
// until DSH restarts.
import { createMethods } from "../lib/methods.mjs";
import { resolveConfig } from "../lib/config.mjs";

const methods = createMethods(
  { sessionController: {}, webServer: { getOrigin: () => "http://127.0.0.1:1" } },
  resolveConfig({}),
  { get: () => undefined },
  {},
);

const info = await methods.discover();
const names = (info.methods ?? []).map((method) => method.name).sort();
const expected = [
  "dsh.discover",
  "dsh.models",
  "dsh.permissions.catalog",
  "dsh.ping",
  "dsh.sessions.ask",
  "dsh.sessions.cancel",
  "dsh.sessions.configure",
  "dsh.sessions.create",
  "dsh.sessions.history",
  "dsh.sessions.list",
  "dsh.sessions.prompt",
  "dsh.sessions.wait",
  "dsh.workspaces.create",
  "dsh.workspaces.list",
];

const missing = expected.filter((name) => !names.includes(name));
const extra = names.filter((name) => !expected.includes(name));
console.log("methods:", names.length);
console.log("missing:", missing.length === 0 ? "(none)" : missing.join(", "));
console.log("unexpected:", extra.length === 0 ? "(none)" : extra.join(", "));

const ask = info.methods.find((method) => method.name === "dsh.sessions.ask");
const params = Object.keys(ask?.params ?? {});
for (const want of ["workspaceId", "model", "reasoningEffort", "permissionPreset"]) {
  if (!params.includes(want)) console.log(`ask params missing: ${want}`);
}
console.log("ask params:", params.join(", "));
console.log("create params:", Object.keys(info.methods.find((m) => m.name === "dsh.sessions.create")?.params ?? {}).join(", "));

const handlers = ["listWorkspaces", "createWorkspace", "permissionCatalog", "configure"];
for (const name of handlers) {
  if (typeof methods[name] !== "function") console.log(`handler missing: ${name}`);
}
console.log("handlers ok:", handlers.join(", "));
process.exit(missing.length === 0 && extra.length === 0 ? 0 : 1);
