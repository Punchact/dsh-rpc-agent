// Smoke-test the wired catalogue without a Harness: the running instance still
// serves whatever module generation it loaded at startup, so this is the closest
// thing to a live check available between restarts.
//
// Two jobs, both cheap and both things that have actually broken here:
//
//   1. the method catalogue the Host serves matches what the code implements;
//   2. the four places that name this package agree with each other. The name is
//      written by hand in package.json, in the patch row, in the browser module
//      factory, and again in the panel's paste-ready config snippet — a rename that
//      misses one of them ships a plugin the Host loads under one id, a browser
//      bundle that registers itself under another, and a copy button that hands
//      people a row that will not load.
import { readFileSync } from "node:fs";
import { createMethods } from "../lib/methods.mjs";
import { resolveConfig } from "../lib/config.mjs";

const failures = [];
function check(ok, message) {
  if (!ok) failures.push(message);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");

const patchName = patch.match(/^\s*name:\s*'?([^'\s]+)'?\s*$/m)?.[1];
const clientId = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)?.[1];
const snippetName = client.match(/name:\s*'([^'\s]+)'/)?.[1];

check(
  patchName === pkg.name,
  `patch row names "${patchName ?? "(missing)"}" but package.json names "${pkg.name}"`,
);
check(
  clientId === pkg.name,
  `client module registers as "${clientId ?? "(missing)"}" but package.json names "${pkg.name}"`,
);
check(
  snippetName === pkg.name,
  `the panel's config snippet tells people to load "${snippetName ?? "(missing)"}" but package.json names "${pkg.name}"`,
);

const methods = createMethods(
  { sessionController: {}, webServer: { getOrigin: () => "http://127.0.0.1:1" } },
  resolveConfig({}),
  { get: () => undefined },
  {},
);

const info = await methods.discover();
const names = (info.methods ?? []).map((method) => method.name).sort();
const expected = [
  "dsh.approvals.pending",
  "dsh.approvals.resolve",
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
check(missing.length === 0, `catalogue is missing: ${missing.join(", ")}`);
check(extra.length === 0, `catalogue advertises unknown methods: ${extra.join(", ")}`);

const paramsOf = (name) =>
  Object.keys(info.methods.find((method) => method.name === name)?.params ?? {});

const askParams = paramsOf("dsh.sessions.ask");
for (const want of ["workspaceId", "model", "reasoningEffort", "permissionPreset"]) {
  check(askParams.includes(want), `dsh.sessions.ask does not document ${want}`);
}

const createParams = paramsOf("dsh.sessions.create");
for (const want of ["workspaceId", "agentPreset", "model", "reasoningEffort", "permissionPreset"]) {
  check(createParams.includes(want), `dsh.sessions.create does not document ${want}`);
}
// The Host assigns ids; create refuses one. Documenting it would invite callers to
// pass a field that is guaranteed to be rejected.
check(!createParams.includes("sessionId"), "dsh.sessions.create must not advertise sessionId");

const handlers = ["listWorkspaces", "createWorkspace", "permissionCatalog", "configure"];
for (const name of handlers) {
  check(typeof methods[name] === "function", `handler missing: ${name}`);
}

console.log(`methods: ${names.length}`);
console.log(`ask params: ${askParams.join(", ")}`);
console.log(`create params: ${createParams.join(", ")}`);
console.log(`names: ${pkg.name} (patch ${patchName}, client ${clientId})`);

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("catalogue ok");
