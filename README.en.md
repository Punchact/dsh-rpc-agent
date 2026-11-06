# dsh-rpc-agent

> Turn the DeepSeek Harness on this machine into a callable RPC / MCP service: Claude Code, Cursor, Codex, Trae, or your own script can hand a task to DSH and get the answer back.

[![npm version](https://img.shields.io/npm/v/@punchact/dsh-rpc-agent)](https://www.npmjs.com/package/@punchact/dsh-rpc-agent)
[![npm downloads](https://img.shields.io/npm/dm/@punchact/dsh-rpc-agent)](https://www.npmjs.com/package/@punchact/dsh-rpc-agent)
[![unpacked size](https://img.shields.io/npm/unpacked-size/@punchact/dsh-rpc-agent)](https://www.npmjs.com/package/@punchact/dsh-rpc-agent?activeTab=code)
[![node](https://img.shields.io/node/v/@punchact/dsh-rpc-agent)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/@punchact/dsh-rpc-agent)](./LICENSE)

[中文](./README.md) · [Design notes](./docs/design.md) · [Changelog](./CHANGELOG.md) · [Release guide](./docs/release.md) · [Security policy](./SECURITY.md)

> [!IMPORTANT]
> **Not affiliated with DeepSeek.** This is a third-party plugin, maintained independently by the community; DeepSeek does not endorse it.
>
> **Holding the token is holding the right to make DSH act on this machine.** Read [Security model](#security-model) before you install.

## 60-second start

```powershell
# 1. Install into the DSH profile (the desktop profile is called "desktop")
dsh plugin add @punchact/dsh-rpc-agent

# 2. Check that it is running. The port can change on every launch; this prints the current address
node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\bin\dsh-rpc.mjs" ping

# 3. Register the MCP entry with your agent (Claude Code here; Cursor/Codex below)
claude mcp add dsh -- node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\bin\dsh-rpc-mcp.mjs"
```

Then tell your agent "use `dsh_ask` to ask DSH: reply with exactly two words: received", or use the CLI directly:

```powershell
# the dsh-rpc.mjs path from the step above, kept in a variable to save typing
$cli = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\bin\dsh-rpc.mjs"
node $cli ask "reply with exactly two words: received" --cwd . --json
```

`ask` is **non-blocking** by default: it returns a handle immediately. Read the result with `dsh_wait` / `wait --session …`. That is deliberate — a caller's tool call usually has a hard 300-second ceiling, so long work has to be "take the order now, deliver later".

## What it is

DSH is not a model here, it is a **whole agent** — with its own tools, skills, MCP servers, sandbox and session context. This plugin does one thin thing: it turns a sentence arriving over HTTP or MCP into one Host prompt, and turns the result back.

```
client (Claude Code / Cursor / Codex / CLI / your script)
    |
    |  JSON-RPC 2.0 over HTTP + Bearer token
    v
http://127.0.0.1:<port>/dsh-rpc   ->   DSH agent
```

The port is **not fixed**: DSH gets one from the OS on every launch, and it changes after a restart. The `origin` printed by `ping` is the current address; the plugin also writes it to `endpoint.json`, which clients re-read on every call (see [Ports and connection stability](#ports-and-connection-stability)).

**What it is not:**

| You might want it for | A better fit |
| --- | --- |
| Asking one question and reading the answer | Just ask in the DSH GUI; no need for a hop |
| Scheduled, background, alerting jobs | DSH's own scheduling, not this plugin's job |
| Driving this DSH from another machine | This plugin is built for loopback; `allowRemote` only relaxes the allow-list, it adds no authentication |

Repository and package name are both `dsh-rpc-agent`; the commands (`dsh-rpc`, `dsh-rpc-mcp`), the endpoint path (`/dsh-rpc`), the state directory (`~/.dsh/dsh-rpc`) and the `DSH_RPC_*` environment variables are runtime contract — renaming them breaks installed configs and paired tokens together.

## Highlights

- **Zero runtime dependencies**: one package added to the profile, no peer-resolution or version conflicts.
- **Real sessions**: it goes through the Host's `sessionController`, so the same turn shows up in the GUI sidebar, can be taken over there, and carries its own log and usage.
- **Long work is never mistaken for failure**: non-blocking handles, `wait` deltas, and explicit `outcome:` / `note:` / `next:` lines that do not trigger a caller's retry policy.
- **Nothing lost across restarts**: the sticky-session table, the escalation ledger, and any "widening not yet returned" debt are all on disk.
- **Unattended sessions cannot hang forever**: three `approvals.mode` settings; `delegate` hands the escalation decision to the caller.
- **A caller that hangs up stops the call, not your work**: abort ≠ cancel; the turn keeps running in the GUI.
- **The port follows the launcher**: `endpoint.json` plus `health --wait`, so no client hard-codes an address.
- **Every promise is guarded by a test**: 183 unit cases, mutation checks, and a real-host integration test.

## Install and update

**From npm (recommended).** This package is a standard DSH bundle; installing from the registry and from a local directory go through the same pnpm path:

```bash
dsh plugin add @punchact/dsh-rpc-agent
```

Or say it inside DSH:

```js
plugin_manager({ action: "install_bundle", target: "@punchact/dsh-rpc-agent" })
```

For a non-default profile add `--profile <name>`; pin a version by writing `@punchact/dsh-rpc-agent@0.7.7` (omitting it means `latest`). The latest on npm is [`0.7.7`](https://www.npmjs.com/package/@punchact/dsh-rpc-agent); this file describes **the code in the repository**, and differences are listed at the top of the [CHANGELOG](./CHANGELOG.md).

Three things that bite on the npm route:

1. **What gets installed is a copy, not a link.** Editing your local checkout afterwards does **not** affect the running plugin. To iterate, use the local-directory route below.
2. **A fresh release can be held back by pnpm's cooling-off window.** Installing a registry spec on release day fails (`minimumReleaseAge` not satisfied). Either pin a version past the window, or allow it explicitly in the profile's `pnpm-workspace.yaml` — pnpm sometimes appends that line itself:

   ```yaml
   minimumReleaseAgeExclude:
     - '@punchact/dsh-rpc-agent@0.4.1 || 0.4.4 || 0.5.3 || 0.7.6 || 0.7.7'
   ```

3. **To confirm which copy is installed**: use `cordis_inspect_query` (`Config.listConfigs`, `input: {"entry":"include:dsh-rpc-bridge"}`) and look at `packageDir` — pointing at `<profile>\node_modules\@punchact\dsh-rpc-agent` means the npm route, pointing at your checkout means the link route. **The version number is not evidence**; it is read from the `package.json` inside the package.

Version history is in [Releases](https://github.com/Punchact/dsh-rpc-agent/releases); **since 0.4.4 every release is published over OIDC and carries SLSA provenance** (`/-/npm/v1/attestations/@punchact%2Fdsh-rpc-agent@<version>` returns 200). `0.4.1` and `0.4.2` were unpublished and cannot be fetched.

**From a local directory (when you are editing the source)**:

```js
plugin_manager({ action: "install_bundle", target: "<absolute-path-to-your-clone>" })
```

- This install is a **link to that directory**; edits need no reinstall.
- But the host does not re-`import` on file changes. To pick up new `lib/*.mjs`, toggle the plugin row off and on:

```js
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: false })
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: true  })
```

`bin/` and `test/` are separate processes and need no reload. The release flow lives in [docs/release.md](./docs/release.md).

## Four ways in

| Way | Good for | Entry point |
| --- | --- | --- |
| MCP tools | Claude Code, Cursor, Codex and other MCP-capable agents | `bin/dsh-rpc-mcp.mjs` |
| CLI | Trying things in a terminal, taking values in scripts | `bin/dsh-rpc.mjs` |
| HTTP JSON-RPC | A process in any language | `POST /dsh-rpc` |
| JS client library | Node-side integration | `@punchact/dsh-rpc-agent/http-client` |

### MCP (recommended)

`bin/` means the **in-package** `bin/` directory. With an npm install it lives under `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\`.

```powershell
claude mcp add dsh -- node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\bin\dsh-rpc-mcp.mjs"
```

Cursor / Codex use the equivalent config form (backslashes in JSON must be escaped on Windows):

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["C:\\Users\\<you>\\.dsh\\profiles\\desktop\\node_modules\\@punchact\\dsh-rpc-agent\\bin\\dsh-rpc-mcp.mjs"]
    }
  }
}
```

On the local-checkout route, replace the path with `<path-to-your-clone>\bin\dsh-rpc-mcp.mjs`. The rest of this document writes `node bin/...`, which means "run from inside the package".

**Nine tools** are exposed:

| Tool | Purpose |
| --- | --- |
| `dsh_ask` | Ask a question or hand over a task; non-blocking by default, returns a handle |
| `dsh_wait` | Wait for this session's current turn and collect the result |
| `dsh_cancel` | Cancel the turn that is running |
| `dsh_sessions` | List sessions (filter by directory, sort by time) |
| `dsh_workspaces` | List workspaces, or register a new one |
| `dsh_permissions` | List permission presets (sandbox mode + approval policy) |
| `dsh_status` | Confirm the endpoint and token are readable |
| `dsh_approvals_pending` | List escalation requests waiting for your answer |
| `dsh_approvals_resolve` | Answer one escalation request |

Parameters are snake_case (the MCP convention), unlike the HTTP layer. Common `dsh_ask` parameters:

| Parameter | Meaning |
| --- | --- |
| `prompt` (**required**) | The sentence to hand to DSH; it must be self-contained |
| `project?` | Key for sticky sessions (see below) |
| `session_id?` | Reuse an existing session |
| `wait?` | **Default `false`**: return a handle at once; `true` blocks until the turn ends |
| `mode?` | `turn` (default) / `steer` / `queue` |
| `cwd?` / `workspace_id?` / `agent_preset?` | Only meaningful when creating a session; the first two are mutually exclusive |
| `model?` / `reasoning_effort?` / `permission?` | Session-level settings, also changeable when reusing a session |
| `timeout_ms?` | Wait budget for this turn |

The first line of a `dsh_ask` result is always `session <id>`, followed by the body and one `— outcome: … · turn … · 5.2s` meta line. Misspelled parameters produce a blunt message: passing `text` to `dsh_ask` yields `` `prompt` is required `` with `isError: true`.

The MCP server and the Harness session it drives **do not share context** — a `dsh_ask` prompt must be self-contained.

### Sticky sessions

Without a `session_id`, `dsh_ask` does not blindly create a session: it looks up `${client name}::${project ?? cwd}` in `~/.dsh/dsh-rpc/sessions.json`, and if the entry still exists and is not a blank session it **continues in that same session**; otherwise it creates one and writes it back. The second call with the same `project` lands in the previous session — that is "one project, one session".

| Parameter | Values | Meaning |
| --- | --- | --- |
| `project` | any stable label | The sticky key; falls back to `cwd` when omitted |
| `reuse` | `auto` (default) / `never` / `latest` | Use the recorded session / always create / take the most recent by `updatedAt` |

Two edges: **different clients do not inherit each other** (`clientInfo.name` is part of the namespace), and a recorded session that was deleted or is still blank is recreated rather than reported as an error. The table is written atomically with 0600; corruption degrades to "no records".

One session eventually becomes a context burden, so after **200** `ask` calls on the same key it rotates: a new session is created and the old id is returned as `previousSessionId` (with `rotated: true`). That threshold counts **deliveries from this bridge**, not the host's total messages — the host offers no cheap counter.

### CLI

```powershell
node bin/dsh-rpc.mjs health                  # unauthenticated liveness probe
node bin/dsh-rpc.mjs health --wait 15000     # poll until ready after a restart
node bin/dsh-rpc.mjs ping                    # a real call with the token
node bin/dsh-rpc.mjs workspaces              # workspaces from the sidebar
node bin/dsh-rpc.mjs permissions             # permission presets (* marks the default)
node bin/dsh-rpc.mjs ask "reply with exactly two words: received" --cwd . --json
node bin/dsh-rpc.mjs ask "look at this workspace" --workspace ws-xxxx --json
node bin/dsh-rpc.mjs ask "continue" --session session-xxxx --json
node bin/dsh-rpc.mjs ask "think with Opus" --session session-xxxx --model anthropic/opus-4.6 --effort high
node bin/dsh-rpc.mjs prompt "a long task…" --session session-xxxx
node bin/dsh-rpc.mjs wait --session session-xxxx --timeout 600000
node bin/dsh-rpc.mjs wait --session session-xxxx --since 42   # only the delta after cursor 42
node bin/dsh-rpc.mjs history --session session-xxxx --limit 20
node bin/dsh-rpc.mjs sessions --limit 10
node bin/dsh-rpc.mjs models                  # models DSH can route to
node bin/dsh-rpc.mjs discover                # self-description: methods, transport, result shape
node bin/dsh-rpc.mjs cancel --session session-xxxx
node bin/dsh-rpc.mjs call dsh.sessions.history '{"sessionId":"session-xxxx"}' --timeout 30000
```

Exit codes: `0` finished · `1` failed or the turn did not end normally · `2` usage error · `3` cannot reach the Harness.

### Plain HTTP

```powershell
$endpoint = (Get-Content "$env:USERPROFILE\.dsh\dsh-rpc\endpoint.json" -Raw | ConvertFrom-Json).url
$token    = (Get-Content "$env:USERPROFILE\.dsh\dsh-rpc\token" -Raw).Trim()
$body = @{ jsonrpc = "2.0"; id = 1; method = "dsh.sessions.ask";
           params = @{ text = "reply with exactly two words: received"; cwd = "C:\path\to\work" } } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri $endpoint `
  -Headers @{ Authorization = "Bearer $token" } -ContentType application/json -Body $body
```

`endpoint.json` is rewritten by the plugin on every launch, so finding the address this way never requires knowing the port.

### JS client library

```js
import { rpcCall } from "@punchact/dsh-rpc-agent/http-client";

const answer = await rpcCall("dsh.sessions.ask", { text: "summarise this repository", cwd: process.cwd() });
console.log(answer.text, answer.usage);
```

That subpath is declared in `exports` (`"./http-client": "./lib/client.mjs"`); in a local checkout it is `import … from "<path-to-your-clone>/lib/client.mjs"`. `rpcCall` resolves to the method's `result`; on failure the thrown Error carries `code` / `data` / `status`, so you can branch on the code.

## Methods

Every method lives under the `dsh.` namespace; the CLI aliases `ping` / `discover` / `ask` / `models` also work as JSON-RPC methods directly.

| Method | Parameters | Returns |
| --- | --- | --- |
| `dsh.discover` | — | Version, running config, transport address, method catalogue |
| `dsh.ping` | — | `{ok, plugin, version, protocol, origin, tokenSource, activeRuns}` |
| `dsh.models` | — | `{default, routableProviders, groups[], failures[]}` |
| `dsh.workspaces.list` | — | `{total, items[]}`, each with id / title / path / status / session count |
| `dsh.workspaces.create` | `path, title?` | `{id, title, path}`; idempotent per path |
| `dsh.permissions.catalog` | — | `{options[], defaultPreset}`, each with a one-line `cost` |
| `dsh.approvals.pending` | `sessionId?, waitMs?` | `{pending[], count, timedOut, mode, deadlineMs}` |
| `dsh.approvals.resolve` | `approvalId, decision, note?` | `{approvalId, sessionId, toolName, decision, note}` |
| `dsh.sessions.configure` | `sessionId, model?, reasoningEffort?, permissionPreset?` | The settings that were applied |
| `dsh.sessions.list` | `limit?, cwd?, sort?` | `{total, sort, cwd, items[]}` |
| `dsh.sessions.create` | `workspaceId? \| cwd?, agentPreset?, model?, reasoningEffort?, permissionPreset?` | `{sessionId, agentPreset, cwd, …}` |
| `dsh.sessions.ask` | see below | A turn result, or a handle (`wait:false`) |
| `dsh.sessions.prompt` | `sessionId, text, mode?, model?, …` | `{accepted, sessionId, requestId, mode}`, returned at once |
| `dsh.sessions.wait` | `sessionId, timeoutMs?, since?` | A turn result |
| `dsh.sessions.cancel` | `sessionId` | `{accepted, sessionId}` |
| `dsh.sessions.history` | `sessionId, limit?` | `{cursor, turn, running, messageCount, records[]}` |

Semantics that are easy to trip over:

- **`dsh.sessions.create` does not accept `sessionId`**: the id is assigned by the Host; passing one returns `-32602` rather than silently swapping in a different id.
- **`dsh.sessions.list` usually reports `createdAt: null`**: measured on this machine, the host's `list()` only returns `updatedAt`, so sorting by `createdAt` keeps the host's original order.
- **`dsh.sessions.ask` has `wait: true` by default** (only the MCP tool `dsh_ask` defaults to `false` — protocol methods keep their shape across minor versions). When another bridge run is already waiting on that session the default answer is `-32004`; add `queue: true` to wait for it to finish.
- **`dsh.sessions.prompt` does not hold the session**: it returns at once without waiting for the turn, so a concurrent `ask` can still take that turn — pair it with `dsh.sessions.wait` when you need the result. Session-level settings such as `model` do take effect here.
- **`limit` must be a positive integer**: 50 by default for `list`, 40 for `history`, maximum 500. Passing `0`, a negative number or a fraction returns `-32602`; nothing is quietly corrected.

`mode` is `turn` (default: deliver only when the session is idle; if it is running you get `-32004` plus `data.next`), `steer` (join the running turn) or `queue` (wait for it to finish). `turn` is the bridge's own judgement — the host only knows `steer` / `queue`, so the bridge decides from a baseline snapshot before delivering. Any other value returns `-32602` rather than degrading silently.

**Error codes** (`error.data` keeps the host's original `kind` and `details`):

| code | Meaning |
| --- | --- |
| `-32700` | Body is not valid JSON |
| `-32600` | Not a valid JSON-RPC request |
| `-32601` | Unknown method |
| `-32602` | Invalid parameters (missing field, empty text, bad sessionId…) |
| `-32603` | Internal plugin error |
| `-32000` | Host-side failure (unclassified) |
| `-32001` | Missing or wrong token |
| `-32002` | Origin is not loopback and `allowRemote` is off |
| `-32003` | Session not found (host `session/not-found`) |
| `-32004` | Session busy: `session/agent-busy`, `session/writer-held`, `session/conflict`, or another bridge run already waiting |
| `-32005` | Wait timed out |
| `-32006` | Call cancelled |

**At the MCP layer**: a tool result is an error **only when the call itself failed** (error code plus a `next:` hint). A turn's `status` always goes into the body as an `outcome:` line; every reason other than `completed` also gets a `note:` (plain-language explanation) and `next:` (what to do). Meeting a `kind` this plugin does not know is not an exception — the host's `TurnEndReasonMap` is merge-extensible, so such outcomes are downgraded to "unverified, check `dsh_sessions()` first" and never dressed up as `completed`.

### Streaming endpoint

`POST /dsh-rpc/stream`, same body as `ask`, responds with one JSON object per line:

```jsonc
{ "type": "session", "sessionId": "session-…", "cwd": "…", "agentPreset": null }   // only when a session is created
{ "type": "progress", "frame": { "type": "event", "event": { "type": "turn/start" } } }
{ "type": "result", "sessionId": "session-…", "status": "completed" }              // the last frame
{ "type": "error", "error": { "kind": "…", "message": "…" } }                      // or this frame
```

If the client disconnects, that wait is aborted (the turn inside the Harness is not cancelled).

## Turn results and waiting

`ask` (blocking) and `wait` return the same shape:

```jsonc
{
  "sessionId": "session-…",
  "turn": 2,
  "status": "completed",          // completed | aborted | blocked | error | max-tokens | interrupted | forked | idle | timeout | unknown | waiting-approval
  "reason": { "kind": "completed" },
  "text": "received",             // the turn's body text; multiple parts joined with blank lines
  "reasoning": "…",               // optional thinking text
  "tools": [],                    // [{callId, name, arguments, output?, isError?}]
  "usage": { "inputTokens": 134981, "outputTokens": 2, "totalTokens": 134983 },
  "durationMs": 5311,
  "timedOut": false,
  "partial": false,               // true when the stream ended before turn/end; text is a fragment
  "sandbox": {                    // only when this turn was blocked by the sandbox
    "denied": true,
    "marker": "[sandbox: file access denied under workspace-write mode]",
    "source": "tool"              // "tool" = read from tool output (reliable); "text" = only seen in the answer
  },
  "next": {                       // appears with sandbox or waiting-approval
    "tool": "dsh_ask",
    "reason": "The turn was blocked by the DSH sandbox. …",
    "args": { "session_id": "session-…" }
  },
  "requestId": "rpc-…",
  "created": true,                // whether this call created the session
  "cursor": 4,
  "since": 4,                     // only present when since was passed
  "turnStartedAt": 1793807450349
}
```

`ask` with `wait:false` (**the default for the MCP tool `dsh_ask`**) returns a **handle** instead:

```jsonc
{
  "sessionId": "session-…",
  "requestId": "rpc-…",
  "status": "running",
  "turn": null,                   // a handle carries no turn number
  "text": "",
  "accepted": true,
  "mode": "queue",                // whether this sentence went in as queue or steer
  "created": false,
  "cwd": "…",
  "permissionPreset": "read-only"
}
```

Conventions for reading results:

- `status` always comes from that turn's own `turn/end` reason; **a cancelled turn is never reported as `completed`**.
- If `turn/end` carries **no `reason`**, `status` is `unknown` and `reason` is `{kind:"unknown", message:"the Host ended the turn without a reason; treat this outcome as unverified"}`. The type says `reason` is required, but that is a TypeScript union — nothing validates it at runtime. Reporting an indescribable outcome as success is the hardest kind of bug to chase.
- `timeout` means the wait expired and **does not** cancel the turn; such a result has no `turn/end` to cite, so the bridge supplies `reason: {kind:"timeout", message:"…it keeps running"}`.
- `partial: true` only appears with `status:"unknown"`: the event stream ended before `turn/end`, so `text` is half a turn.
- `cwd` is filled in only when `created:true`.
- `waiting-approval` appears only with `approvals.mode=delegate`, when the turn is waiting for your answer — see [Permissions and escalation](#permissions-and-escalation).

`tools[].output` is truncated at 4000 characters per entry with a 20000-character budget per turn; overflow is written as `… (omitted, N chars: this turn's tool-output budget of 20000 is spent)`.

### `since` returns only the delta

Without it you get the whole turn; with it you get only events whose `seq > since`, and `text` narrows to that span. **`status` / `turn` / `tools` / `usage` / `sandbox` still describe the whole turn**, and `cursor` keeps advancing. Poll progress with `since: <last cursor>`; do not resend the prompt.

### Sliced waiting and deadlines

- **A single HTTP request does not survive five minutes**: Node's built-in `fetch` has a 300-second `headersTimeout`; measured, it fails at 303.9 s with `fetch failed`. So the bridge cuts a wait into `maxWaitSliceMs` (default **120000**, ceiling 240000) and returns `status:"timeout"` with `sliceMs` / `requestedMs` for the caller to continue. **The CLI and the MCP tools already loop for you** — pass the total budget; if you write your own client, either slice or never request a wait longer than 300 seconds.
- `waitedMs` is wall clock: a final slice shorter than 1 second is raised to the 1000 ms floor, so it can exceed the budget by up to a second; `slices` is the number of requests.
- **Our deadline writes the answer, the host does not**: every event read races this run's deadline, and the trailing cleanup (unsubscribing from the host's event stream) is bounded at one second — a stuck host costs us one delay, not the answer.
- **"Not done yet" is not failure**: `status:"timeout"` only says this slice expired; the turn keeps running in the Harness. Resending means asking again — extra sessions and repeated side effects. Use `wait` / `history` for progress.
- **Turn ownership**: after delivering a prompt, the plugin looks for its own `user/message` in the event stream (`source.rpcId` equals this call's `requestId`) and anchors on the turn it lands in. So **when someone else speaks in that session, their answer is never taken for yours** — that turn's `turn/end` is skipped and waiting continues for your own turn.

## Workspaces, models, reasoning effort

These are DSH's own concepts; the bridge only forwards them and invents no new switches.

**Location (workspace / directory) is decided only at creation time.** `workspaceId` goes through `workspace.attachSession`, so the session appears under that workspace in the GUI sidebar; `cwd` only sets a directory and attaches no workspace. They are mutually exclusive and passing both is rejected (`-32602`). Passing a location parameter together with an existing session is rejected the same way — to move, create a new session. `agentPreset` behaves identically.

Neither the CLI nor the MCP server filters these on the client side: they are forwarded, and the bridge gives one uniform rejection. That way "passed but ignored" never disguises itself as "passed and applied".

```powershell
node bin/dsh-rpc.mjs workspaces                            # see what exists
node bin/dsh-rpc.mjs ask "look at this project" --workspace ws-1   # go in
node bin/dsh-rpc.mjs models | head -40
node bin/dsh-rpc.mjs ask "think again" --session session-xxxx --model anthropic/opus-4.6 --effort high
```

**Model names** may be written as `provider/model`; a bare id is looked up in the model catalogue — a unique match is used, several matches produce an error listing the disambiguating forms, zero matches tells you to run `dsh.models`. **It never guesses.** `reasoningEffort` must be given in the same request as `model`: the Host offers no "read back the current model" call.

> [!WARNING]
> **Switching models stores the choice as the profile default** (host behaviour, identical to switching models in the GUI). After an external agent switches, sessions you open in the GUI use that model too.

## Permissions and escalation

A **permission preset** bundles a sandbox mode with an approval policy; the name is validated against the Host's catalogue first, and an unknown name errors with the available options. Each entry carries a one-line `cost`, because the deployment's own `description` is usually empty.

**Do not pass `permission` by default; escalate once after you are actually blocked:**

1. The bridge reports `sandbox.denied: true` and a `next` in that turn's result;
2. `next.args` carries only `session_id`: **the decision to retry with `danger-full-access` is yours**, the bridge neither makes it for you nor stuffs that parameter into the returned value (otherwise a blocked agent could talk itself into an escalation with its own wording);
3. **Escalate once.** That preset's approval policy is `never`, so after escalating nothing blocks that turn — it is not "a wider default", it is "the last resort when blocked", and you should say so in your answer.

Why escalation has to come from the caller: DSH's sandbox appends a hint to a denied output saying it may retry with `sandbox_permissions`, but sessions driven by this bridge are unattended — under `approval: ask` there is no answerer, so the request normalises to `unavailable` (which does not allow), and under `approval: never` the system prompt forbids asking for escalation at all. Both roads are closed, so only the caller can switch presets and ask again.

The escalation ladder is a closed table: `read-only` may go to `workspace-write` or `danger-full-access`, while **`workspace-write` may only go to `danger-full-access`** — there is no middle rung.

```powershell
node bin/dsh-rpc.mjs permissions
node bin/dsh-rpc.mjs ask "run the tests" --permission workspace-write
```

### Unattended sessions and escalation (`approvals`)

Sessions created by this bridge have nobody sitting in front of the GUI. The moment a model asks for an escalation by carrying `sandbox_permissions`, the host suspends that call waiting for an answer — **how long depends on whether an answerer exists**, and a bridge-created child session has none. Measured twice on this machine: after `approval/asked` no `approval/decided` ever arrived, and the caller timed out on its 120-second budget every time.

Three modes:

| Mode | Behaviour |
| --- | --- |
| `off` (default) | The bridge installs no gate; the host's own fail-closed behaviour stands |
| `deny` | The bridge refuses "escalate in place" ahead of the tool, at `tools/pre-execute` |
| `delegate` | The decision is handed to the agent that dispatched the task |

**`deny`** only tightens, never widens: in a session this bridge created, a call carrying `sandbox_permissions` is refused before dispatch and the model immediately sees

```
approvals.mode=deny refused a sandbox escalation to "danger-full-access" for tool "pwsh"; the call was not executed.
```

Calls that do not escalate are untouched; sessions this process did not create (including the one a human is watching in the GUI) are left to their own answerer. Refusals are counted in `/status` under `calls.approvals.denied`.

**`delegate`** suspends the request; the caller answers with two methods:

| Method | Purpose |
| --- | --- |
| `dsh.approvals.pending({ sessionId?, waitMs? })` | List pending requests; `waitMs` turns it into a long poll of up to 120 seconds |
| `dsh.approvals.resolve({ approvalId, decision, note? })` | Answer one: `allow-once` or `reject` |

Points that matter:

- **A turn stopped on a pending approval returns at once**: `dsh_ask` / `dsh_wait` return `status: "waiting-approval"` with `pendingApproval` and a `next` pointing at `dsh_approvals_resolve`. Otherwise the caller sits inside the loop of "answering its own question".
- **No answer means refusal**: when `deadlineMs` expires the request is treated as rejected; it is never allowed by default.
- **The widening lasts only for the approved call**: the host has no "allow once" interface, so the session preset is the only lever the bridge holds. It switches the preset temporarily and restores it as soon as the call finishes (`tools/post-execute`), with a five-minute fallback timer. A downstream listener throwing, the result handler throwing and a host cancellation all restore it; `dispose()` covers plugin unload.
- **Counted per session, at most 3 per session**: only one escalated call may run in a session at a time (concurrent requests in the same tick produce a single pending record), and other non-escalating calls in the window are **held** until it closes, so nothing rides along for free.
- **Only `workspace-write` and `danger-full-access` may be requested**; anything else is refused without asking.
- While `approvals.mode` is not `off`, `dsh.sessions.configure` cannot raise a session straight to `danger-full-access`, and cannot touch a session this bridge does not own.
- Allows and refusals are counted in `/status` under `calls.approvals.allowed` / `calls.approvals.denied`.

Decision packet fields: `approvalId` (a random UUID, not enumerable), `sessionId`, `toolName`, `callId`, `escalation`, `argv` (a digest of the command or path), `args` (the **whole argument object** as redacted JSON, credential-shaped values masked, capped at 4000 characters), `argsTruncated`, `cwd`, `preset` (the session's **current** preset, null when unreadable), `reason` (the sub-agent's own words, truncated to 500 characters), `untrusted: true`, `createdAt`, `expiresAt`.

**After a restart**: escalations used per session, the sessions this bridge owns, and any debt of "this widening was not returned" all live in `$DSH_HOME/dsh-rpc/approvals.json` (0600, written via `.tmp` then rename). A restart neither resets the allowance nor silences the gate for old sessions; if the process is killed before a widening is returned, the next start reads that ledger and puts the preset back (a failure is only logged as a warning). The file is not written while `approvals.mode=off`.

> [!NOTE]
> **Why not `ctx.on("approval/request")`**: the approval service dispatches through `scopeTarget(req.agent, req.agent)`, which only reaches answerers "inside that agent's own composition". Measured by registering once in the plugin context and once in the root context: on a real escalation the listener **was never called** (the GUI panel kept waiting), whereas `tools/pre-execute` is a global waterfall that covers every agent.

## Configuration

Configured through the `config` of `cordis.patch.yml`; every key has a default:

```yaml
- insert:
    - id: dsh-rpc-bridge
      name: '@punchact/dsh-rpc-agent'
      config:
        token: ''              # leave empty to generate and persist one
        allowRemote: false     # accept non-loopback origins
        defaultCwd: ''         # used when ask has no cwd; then the process cwd
        defaultAgentPreset: '' # default preset for new sessions
        defaultTimeoutMs: 600000
        maxWaitSliceMs: 120000 # length of one wait response
        historyBudgetMs: 30000 # longest a history snapshot may take
        maxBodyBytes: 1048576
        maxSessions: 200       # concurrent waits
        approvals:
          mode: off            # off (default) | deny | delegate
          deadlineMs: 60000    # delegate: how long to wait for the caller's answer; expiry counts as a refusal
```

Other keys: `enabled`, `tokenFile` (custom token path), `path` (default `/dsh-rpc`), `logRequests`. The `DSH_RPC_TOKEN` environment variable overrides the token (higher priority than the file), which suits CI or setups that cannot persist a file.

## Security model

**In one sentence: this plugin's bearer token is the right to make DSH act on this machine.**

A process holding the token can create sessions and deliver prompts, so DSH will use **its own** tools to read files, write files, run commands and reach the network — bounded by DSH's sandbox and approval policy, not by this plugin. The plugin does exactly two things: pass the request to the Host, pass the result back. It widens no permission and reviews no content.

| Surface | State |
| --- | --- |
| Transport | loopback + Bearer token; by default only `127.0.0.1` / `::1` / `::ffff:127.0.0.1`, everything else 403 |
| Token storage | `%USERPROFILE%\.dsh\dsh-rpc\token`, 32 random bytes on first start, 0600 |
| Token comparison | SHA-256 plus a timing-safe compare, no early byte-wise return |
| Unauthenticated endpoint | `GET /health`, returns only `{ok, plugin, version, protocol, authenticated}` |
| Request body cap | 1 MiB (configurable), 413 beyond it; never reads unbounded into memory |
| Origin check | from the socket's `remoteAddress`, never from `X-Forwarded-For` |

**What it deliberately does not do**: no transport encryption (loopback only, no external interface), no rate limiting, no request signing, no prompt logging by default (`logRequests` logs only request heads when explicitly enabled).

**If you expose it to the LAN**: `allowRemote: true` only turns off the loopback allow-list; it adds **no** authentication strength. Such a deployment belongs behind a TLS-terminating proxy with its own access control.

**Shared machines**: the token file is the credential. Do not paste it into shell history, CI plain-text variables or chat logs; if you suspect a leak, delete the file and reload the plugin — a new token is generated and the old one stops working immediately.

## Ports and connection stability

DSH's web port is decided by the launcher, and the desktop app lets the OS pick it, so it **changes after a restart**. This plugin does not fix a port.

**Why not pin it in the patch**: the `dsh-web-app` webserver row reads `ctx.webStartup.port ?? 3080` through `!!js`, and a `cordis.patch.yml` override **replaces the whole row config** — pinning the port means restating `host` / `tls` / `compression` and silently losing any key a future version adds. DSH would also fail to start when the port is taken.

**The plugin publishes the endpoint**: on every activation it calls `ctx.webServer.getOrigin()` and writes the real address into `endpoint.json`; clients (CLI / MCP / `lib/client.mjs`) **re-read it on every call** and never cache it.

```jsonc
{
  "url": "http://127.0.0.1:3820/dsh-rpc",
  "origin": "http://127.0.0.1:3820",
  "path": "/dsh-rpc",
  "version": "0.7.7",                        // the version the running copy reports
  "plugin": "dsh-rpc-agent",
  "pid": 12345,                              // the Host process that wrote this file
  "startedAt": "2026-11-05T01:05:58.000Z",   // when that process started
  "updatedAt": "2026-11-05T01:06:31.924Z"    // when it was last written
}
```

`pid` and `startedAt` let a client tell whether the Harness restarted: if neither changed and you still cannot connect, it is not port drift.

**Only one error is retried during a restart window**: clients re-read the endpoint and retry once, and only for `ECONNREFUSED` (TCP refused, request never left). `ECONNRESET` / `EPIPE` / timeouts are **not** retried, because the bytes may already have been accepted and a resend risks delivering the prompt twice. An explicit `--url` or `DSH_RPC_URL` is not retried either.

**Chaining after a restart**:

```powershell
node bin/dsh-rpc.mjs health --wait 15000; if ($?) { node bin/dsh-rpc.mjs ask "keep going" --session session-xxxx }
```

`--wait` re-reads the endpoint every 250 ms and probes; it returns 0 (printing the elapsed time) when ready and 3 on timeout.

**Still-failing cases**: the Harness is starting and the plugin has not activated yet (`endpoint.json` still holds the previous address); several instances running at once (one file, last write wins). Pass `--url` explicitly for both.

**After the caller hangs up**: a non-streaming request aborts that call when the socket closes — the event iteration stops and the run slot is released — but **the turn is not cancelled**; it keeps running in the Host and can still be collected with `wait` (and seen in the GUI). That is the difference between abort and cancel.

**How an aborted call is counted**: in `/status` under `calls.outcomes`, not `errors` — `timeouts` means "the budget ran out", `cancelledByClient` means "the caller left first".

## Follow along in the GUI

The CLI's stdout lives only in the terminal that ran it — that is the **caller process'** output. But the turn being driven **is a real session inside the Harness**, so it also shows up in the GUI:

| Layer | Where you see it |
| --- | --- |
| The CLI process' stdout / stderr / exit code | only in that terminal |
| That turn's session and full conversation | the GUI sidebar session list; open it for the transcript, tool calls and token usage |

This works because the plugin goes through the Host's `sessionController` (rather than taking a bare agent): the session log, title generation and `running` state all come from the same store.

Three practical notes:

1. **Always pass `--cwd`.** Without it the Host uses the process working directory (usually DSH's own profile), and the session is hard to place in the sidebar.
2. **Keep the returned `sessionId`.** Later `wait` / `history` / follow-ups / taking over in the GUI all need it.
3. **The GUI does not pop up by itself.** The session is simply added to the list; you open it.

**Approvals still follow the GUI or your policy**: if that turn triggers a tool call needing human approval, it hangs on the host side; with nobody opening the session it waits until `timeoutMs` runs out — then `ask` returns `status:"timeout"` and **does not** cancel the turn (continue in the GUI, or `dsh.sessions.cancel`).

## Status panel

Once installed, a **"RPC Bridge"** entry appears on the left of the settings window (`Settings → RPC Bridge`). It answers "is the bridge alive, and what was called recently":

| Block | Content |
| --- | --- |
| Status light | online / unreachable, version, last refresh (polled every 2 seconds) |
| Runtime info | endpoint, protocol version, credential source, uptime, `pid`, Node version, whether remote is allowed, total and failed calls |
| Running turns | every active `ask`/`wait`: first 8 characters of the run id, whether it has a session, whether it carries a prompt, elapsed time |
| Last 12 calls | time, method name, duration, ok/failed with error code |
| Method usage | per-method counts and error counts, plus the two non-failure outcomes `timeouts` / `cancelledByClient` |
| How to connect | two copyable commands (MCP registration, one CLI try) |
| Config snippet | the `cordis.patch.yml` row generated from the current values, one click to copy |

It reads **`GET /dsh-rpc/status`**: the same trust boundary as `/health` — **loopback only, no token**, because a page in the browser cannot reach the token in `endpoint.json`. In exchange that endpoint must "say nothing":

- no token, no `sessionId` (active runs expose only the first 8 characters of the run id and whether a session exists);
- no call parameters at all — no prompt text, no tool arguments. Call accounting stores **method name, duration and result code** only.

Everything the page shows comes from that read-only endpoint; it writes nothing. To make the panel disappear, disable the plugin; `/status` goes down with it.

> Changed the port? No action needed: the page requests the fixed path `/dsh-rpc/status` (the plugin keeps that alias even when `path` is customised), and `origin` in the status payload is always the real listening address.

## Known edges

- **One "asking" run per session**: two concurrent `ask` calls make the second return `-32004` by default; `queue: true` makes it wait its turn (within its own `timeoutMs`, `-32005` on timeout), and while queued `ping` / the status page shows `state: "queued"`. This only constrains this plugin — the GUI or another agent can still interject; ownership is claimed by `rpcId`, so another agent's answer is never taken for yours, at the price of waiting for it to finish. `wait` is unrestricted.
- **`wait` only sees the snapshot window**: it relies on the `follow` first-frame snapshot to identify the current/last turn, capped at 500 events. On a very long session whose snapshot was truncated before the target turn, the status may be reported as `completed`; call `history` with the `sessionId` for the authoritative value.
- **Batch requests run serially**: JSON-RPC entries in one HTTP batch execute **in order**, so a slow `ask` blocks the rest. Use several connections for concurrency.
- **Approval policy is not copied**: the Harness still applies its own approval and sandbox policy; a tool needing human approval can leave the turn hanging for a long time. `permissionPreset` sets that session's default preset, it is not a grant.
- **Location is decided at creation**: `workspaceId` / `cwd` do nothing for an existing session — the bridge rejects them instead of ignoring them. Moving means creating a session.
- **Switching models changes the profile default**: `selectModel` is the Host's model-switch entry point and it stores the choice as the profile default.
- **Permission presets need an optional service**: on a deployment without the `permissionPresets` service, passing `permissionPreset` yields `-32000` with an explanation.
- **Workspaces are create-only**: the bridge exposes `workspaces.list` / `workspaces.create`; delete and rename them in the GUI.
- **Only host-visible sessions are forwarded**: `sessions.list` and `history` go through the Host's `remoteAccess` filter.
- **Body truncation**: at most 4000 events are kept per turn; on very long turns `text` is still complete (it comes from `assistant/message`) but the `tools` list may be truncated.
- **Token exposure**: the token is stored alongside DSH's other credentials. **Child sessions created by this bridge can read it** — the sub-agent runs as the same OS user and a `workspace-write` sandbox still allows reading the user directory (measured 2026-11-06: a child session read the token and called `dsh.ping` over `POST /dsh-rpc`). So the approval right in `approvals.delegate` guards against **mistakes and prompt injection**, not against a process of the same user that wants more privilege for itself.
- **The approval gate covers one road only**: `deny` / `delegate` intercept `sandbox_permissions` **in tool arguments**. Changing a preset through `configure`, or choosing `permissionPreset` when creating a session, is another road — the former is forbidden while `approvals.mode` is not `off`, but a preset chosen by the caller **when creating** a session is not constrained by the gate (that is the dispatcher's decision, not the sub-agent's).
- **No declared `Config` schema**: the plugin validates the row's `config` by hand instead of exporting `Config` (to stay dependency-free). The cost is that `cordis_inspect_query` shows `status: absent` for that row and there is no visual form; see [Configuration](#configuration).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `dsh-rpc: 401` | Token mismatch. Delete `%USERPROFILE%\.dsh\dsh-rpc\token` and reload the plugin to regenerate |
| `403` | Origin is not loopback; check for a proxy, or enable `allowRemote` |
| `-32004 … already has a bridge run waiting for its turn` | An `ask`/`prompt` is already waiting on that session; use another session or wait it out (`wait` can observe in parallel) |
| Exit code `3` (cannot connect) | The Harness is not running, or the plugin row is disabled; probe with `node bin/dsh-rpc.mjs health` |
| Source changed, behaviour did not | The host cached the module: toggle `set_plugin` off and on |
| Source changed, behaviour did not (npm install) | The npm route installs a copy unrelated to your checkout; use the local-directory install to iterate |
| Install fails with the cooling-off window / version unavailable | A fresh release may still be inside `minimumReleaseAge`; pin a version past the window, or allow it as described in [Install and update](#install-and-update) |
| `Cannot read properties of undefined (reading 'throwIfAborted')` | Older versions called the host's `prompt`/`list` with `undefined`; fixed |
| Plugin row shows `absent` | Expected: the plugin exports no `Config` schema, so `cordis_inspect_query` has no config contract |

## Development and tests

```powershell
cd dsh-rpc-plugin
npm test                       # ten suites at once, 183 cases; needs no Harness and no npm install
node test/host.test.mjs        # 1 case: real-host integration (needs npm ci first)
node test/e2e.mjs --cwd .      # 14 cases: end to end against a real Harness
node test/edge.mjs             # 24 cases: protocol/edge adversarial, against a real Harness
```

<details>
<summary>What each of the ten suites guards</summary>

| Suite | Cases | Guards |
| --- | --- | --- |
| `methods` | 76 | Turn ownership, steer, timeouts, abort reasons, history, cancel, parameter contracts |
| `mcp-format` | 19 | Result rendering: `note:` / `next:` / truncation / de-duplication / pending approvals |
| `registry` | 8 | Sticky-session table I/O, corruption fallback, rotation |
| `pending` | 36 | Pending store, long polling, cancellation withdrawal, allowance pre-claim, transaction boundary |
| `approvals` | 11 | Config validation, the gate's deny/delegate branches, ownership, allow-list |
| `approval-state` | 8 | Ledger across restarts, field-wise merge, TTL, orphan recovery |
| `wait` | 6 | Sliced waiting (real HTTP stub) |
| `abort` | 7 | The abort chain (real socket / in-process registry) |
| `client` | 6 | Client retries and error reporting |
| `status` | 6 | `/status` payload and route-mounting contract |

</details>

`npm test` runs those ten suites in a fixed order; `npm run test:host` runs the real-host integration; `npm run test:e2e` / `npm run test:edge` need a live Harness.

> [!TIP]
> **Do not use `node --test`**: it forks a child process per file, which DSH's sandbox blocks with `spawn EPERM`.

A few worth calling out:

- **Real-host integration** does not use a fake `webServer`: it starts a real listener with `new Context()` + `ctx.plugin(WebServer, {host:'127.0.0.1', port: 0})`, applies the plugin, then makes real HTTP calls asserting `/health` 200, RPC without a token 401 and `/status` `origin` matching the real listener — **finally running the plugin's own disposer and asserting `/health` and `/status` both turn 404**. That is the only test that catches the real incident where a leaked route from a previous generation broke reloads.
- **End to end** goes through the very same `lib/client.mjs` an external agent uses, so green here means the whole chain plugin → Host `sessionController` → HTTP → JSON-RPC → caller holds.
- **Edge** probes the protocol layer: batches, notifications, id shapes, auth headers, oversized bodies (a genuine 413, not a dropped connection), parameter-injection defences, timeout clamping, concurrent asks, `limit` semantics.
- **Port drift** (manual): point `endpoint.json` at a dead port and run `dsh-rpc ping`; expect exit code 3 and a readable error mentioning `nothing is listening`, `pid` and `health --wait`.

Last actual run: unit 183/183 (CI), host 1/1 (2026-11-06); locally the same commit gives 182 passes plus one case that the sandbox blocks (`spawn EPERM`); end-to-end 14/14, edge 24/24 (2026-11-05).

## License

[MIT](./LICENSE) © 2026 Punchact. Design trade-offs are in [docs/design.md](./docs/design.md), the security policy in [SECURITY.md](./SECURITY.md), the release flow in [docs/release.md](./docs/release.md).
