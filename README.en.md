# dsh-rpc-agent

[中文](./README.md) · unofficial

> The repository and the package are both named `dsh-rpc-agent`. The CLI names (`dsh-rpc`, `dsh-rpc-mcp`), the
> endpoint path (`/dsh-rpc`), the state directory (`~/.dsh/dsh-rpc`) and the `DSH_RPC_*` variables never change —
> they are the runtime contract, and renaming them would break every installed configuration and paired token.

Turns DeepSeek Harness into an **RPC service** any local agent can call: Claude Code, Codex CLI, Cursor, Trae, or
your own script hands DSH a task and gets its final answer back.

> **This project is not affiliated with DeepSeek.** It is a third-party plugin maintained independently, neither
> endorsed nor supported by DeepSeek. Read §7 before you use it: holding this plugin's token is holding permission
> to drive DSH on this machine.

## What it is

DSH is not a model here — it is a **complete agent**, with its own tools, skills, MCP servers, sandbox and session
context. The plugin does one thin thing: turn one sentence arriving over HTTP or MCP into one Host prompt, and hand
the result back.

```
client (Claude Code / Cursor / Codex / CLI / your script)
    |
    |  JSON-RPC 2.0 over HTTP + Bearer token
    v
http://127.0.0.1:<port>/dsh-rpc   ->   DSH agent
```

The port is **not fixed**: DSH gets one from the OS at each start, so it changes after a restart. `node bin/dsh-rpc.mjs
ping` prints the current `origin`; the plugin also writes it to `endpoint.json`, which clients re-read on every call
(see §8).

## Contents

1. [Four ways in](#1-four-ways-in)
2. [Endpoint and credentials](#2-endpoint-and-credentials)
3. [Methods](#3-methods)
4. [Error codes](#4-error-codes)
5. [Configuration](#5-configuration)
6. [Install and update](#6-install-and-update)
7. [Security model](#7-security-model)
8. [Ports and connection stability](#8-ports-and-connection-stability)
9. [Following a CLI task in the GUI](#9-following-a-cli-task-in-the-gui)
10. [Status panel in Settings](#10-status-panel-in-settings)
11. [Verification](#11-verification)
12. [Known edges](#12-known-edges)
13. [Troubleshooting](#13-troubleshooting)

Other documents: [CHANGELOG](./CHANGELOG.md) · [SECURITY](./SECURITY.md) · [release handbook](./docs/release.md) ·
[design notes](./docs/design.md)

**Version**: the latest published build is [`0.7.7`](https://www.npmjs.com/package/@punchact/dsh-rpc-agent). This
file describes **the code in the repository**; differences between the two are at the top of the CHANGELOG.

---

## 1. Four ways in

| Way | Good for | Entry point |
| --- | --- | --- |
| MCP tools | Claude Code, Cursor, Codex and other MCP clients | `bin/dsh-rpc-mcp.mjs` |
| CLI | Trying things by hand, shell substitution | `bin/dsh-rpc.mjs` |
| HTTP JSON-RPC | Any process, any language | `POST /dsh-rpc` |
| JS client | Node-side integration | `@punchact/dsh-rpc-agent/http-client` |

### 1.1 MCP (recommended)

`bin/` means **the package's** `bin/` directory. Installed from npm (the recommended route, §6) it lives under
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\`.

```powershell
claude mcp add dsh -- node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\bin\dsh-rpc-mcp.mjs"
```

Cursor / Codex use the equivalent config-file form (remember JSON escaping on Windows):

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

Installing from a local clone instead? Swap the path for `<path-to-your-clone>\bin\dsh-rpc-mcp.mjs`. Everywhere
else this document writes `node bin/...`, meaning "run it with the current directory inside the package".

It exposes **9 tools**:

| Tool | Purpose |
| --- | --- |
| `dsh_ask` | Ask one question or hand over one task; returns a handle unless you ask it to wait |
| `dsh_wait` | Wait for that session's turn and collect the result |
| `dsh_cancel` | Abort the turn that is running |
| `dsh_sessions` | List sessions (filter by directory, sort by time) |
| `dsh_workspaces` | List workspaces, or register a new one |
| `dsh_permissions` | List permission presets (sandbox mode + approval policy) |
| `dsh_status` | Confirm the endpoint and token are readable |
| `dsh_approvals_pending` | List escalation requests waiting for your decision |
| `dsh_approvals_resolve` | Answer one escalation request |

Arguments are snake_case (the MCP convention), unlike the HTTP layer. The common `dsh_ask` arguments:

| Argument | Meaning |
| --- | --- |
| `prompt` (**required**) | The sentence handed to DSH; it must stand on its own |
| `project?` | Sticky-session key (1.1.1) |
| `session_id?` | Reuse an existing session |
| `wait?` | **Defaults to `false`**: a handle comes back at once; `true` blocks for the turn |
| `mode?` | `turn` (default) / `steer` / `queue` — see §3 |
| `cwd?` / `workspace_id?` / `agent_preset?` | Create-time only; the first two are mutually exclusive |
| `model?` / `reasoning_effort?` / `permission?` | Session-level settings; also valid when reusing |
| `timeout_ms?` | Wait budget for this turn |

The first line of a `dsh_ask` result is always `session <id>`, then the body, then one
`— outcome: … · turn … · 5.2s` metadata line. A wrong argument name is reported plainly: passing `text` to
`dsh_ask` yields `` `prompt` is required `` with `isError: true`.

The MCP server and the Harness session **share no context** — the prompt you give `dsh_ask` must be
self-contained.

#### 1.1.1 Sticky sessions

Without `session_id`, `dsh_ask` does not blindly create a session: it looks up `${client name}::${project ?? cwd}`
in `~/.dsh/dsh-rpc/sessions.json`, and if that session still exists and is not blank it **reuses it**; otherwise it
creates one and writes the entry back. The second call for the same `project` therefore lands in the same session —
that is how "one project, one session" works.

| Argument | Values | Meaning |
| --- | --- | --- |
| `project` | any stable label | The sticky key; falls back to `cwd` |
| `reuse` | `auto` (default) / `never` / `latest` | Use the recorded session / always create / take that project's most recent by `updatedAt` |

Two boundaries: **clients never inherit each other's sessions** (`clientInfo.name` is part of the namespace), and a
recorded session that was deleted or is still blank means "create a new one", not an error. The table is written
atomically with mode 0600; a corrupt file simply means "no record".

One session eventually becomes a context burden, so after **200** `ask` deliveries on the same key the plugin
rotates: it creates a new session and reports the old id as `previousSessionId` (`rotated: true`). That threshold
counts **this bridge's deliveries**, not Host messages — the Host has no cheap counter.

### 1.2 CLI

```powershell
node bin/dsh-rpc.mjs health                  # unauthenticated liveness
node bin/dsh-rpc.mjs health --wait 15000     # poll until ready after a restart
node bin/dsh-rpc.mjs ping                    # a real, token-bearing call
node bin/dsh-rpc.mjs workspaces              # workspaces shown in the sidebar
node bin/dsh-rpc.mjs permissions             # permission presets (* = default)
node bin/dsh-rpc.mjs ask "只回复两个字：收到" --cwd . --json
node bin/dsh-rpc.mjs ask "look at this workspace" --workspace ws-xxxx --json
node bin/dsh-rpc.mjs ask "continue from there" --session session-xxxx --json
node bin/dsh-rpc.mjs ask "think with Opus" --session session-xxxx --model anthropic/opus-4.6 --effort high
node bin/dsh-rpc.mjs prompt "long running task…" --session session-xxxx
node bin/dsh-rpc.mjs wait --session session-xxxx --timeout 600000
node bin/dsh-rpc.mjs wait --session session-xxxx --since 42   # only events after cursor 42
node bin/dsh-rpc.mjs history --session session-xxxx --limit 20
node bin/dsh-rpc.mjs sessions --limit 10
node bin/dsh-rpc.mjs models                  # models DSH can route to
node bin/dsh-rpc.mjs discover                # self-description: methods, transport, shapes
node bin/dsh-rpc.mjs cancel --session session-xxxx
node bin/dsh-rpc.mjs call dsh.sessions.history '{"sessionId":"session-xxxx"}' --timeout 30000
```

Exit codes: `0` done · `1` failed or the turn did not end cleanly · `2` usage error · `3` cannot reach the Harness.

### 1.3 Plain HTTP

```powershell
$endpoint = (Get-Content "$env:USERPROFILE\.dsh\dsh-rpc\endpoint.json" -Raw | ConvertFrom-Json).url
$token    = (Get-Content "$env:USERPROFILE\.dsh\dsh-rpc\token" -Raw).Trim()
$body = @{ jsonrpc = "2.0"; id = 1; method = "dsh.sessions.ask";
           params = @{ text = "reply with one word: ok"; cwd = "C:\path\to\work" } } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri $endpoint `
  -Headers @{ Authorization = "Bearer $token" } -ContentType application/json -Body $body
```

`endpoint.json` is rewritten at every start, so reading the address this way needs no knowledge of the port.

### 1.4 JS client

```js
import { rpcCall } from "@punchact/dsh-rpc-agent/http-client";

const answer = await rpcCall("dsh.sessions.ask", { text: "summarize this repository", cwd: process.cwd() });
console.log(answer.text, answer.usage);
```

The subpath is declared in `exports` (`"./http-client": "./lib/client.mjs"`); in a local clone it is
`import … from "<path-to-your-clone>/lib/client.mjs"`.

`rpcCall` resolves to the method's `result`; on failure it throws an Error carrying `code` / `data` / `status`, so
you can branch on the code.

---

## 2. Endpoint and credentials

| Item | Value |
| --- | --- |
| RPC endpoint | `POST /dsh-rpc` (JSON-RPC 2.0) |
| Streaming endpoint | `POST /dsh-rpc/stream` (NDJSON) |
| Liveness | `GET /dsh-rpc/health` (**unauthenticated**) |
| Credential | `Authorization: Bearer <token>` or `X-DSH-RPC-Token: <token>` |
| Token file | `%USERPROFILE%\.dsh\dsh-rpc\token` (32 random bytes as hex, 0600) |
| Endpoint description | `%USERPROFILE%\.dsh\dsh-rpc\endpoint.json` (rewritten each start) |

A full address looks like `http://127.0.0.1:<port>/dsh-rpc`. `<port>` is chosen by DSH and may differ after a
restart. `endpoint.json`:

```jsonc
{
  "url": "http://127.0.0.1:3820/dsh-rpc",
  "origin": "http://127.0.0.1:3820",
  "path": "/dsh-rpc",
  "version": "0.7.7",                        // the version the running plugin reports
  "plugin": "dsh-rpc-agent",
  "pid": 12345,                              // the Host process that wrote this file
  "startedAt": "2026-11-05T01:05:58.000Z",   // when that process started
  "updatedAt": "2026-11-05T01:06:31.924Z"    // when this file was written
}
```

`pid` and `startedAt` tell a client whether the Harness restarted: both unchanged yet unreachable means it is not
port drift.

- **The token is generated for you**: created and stored on first activation; the CLI and MCP server read it
  automatically.
- **Loopback only**: by default `127.0.0.1` / `::1` / `::ffff:127.0.0.1` are accepted and everything else gets 403.
  Expose it to a LAN only by explicitly setting `allowRemote`.
- **Health is deliberately unauthenticated**: it returns `{ok, plugin, version, protocol, authenticated}` and nothing
  about sessions or configuration.

---

## 3. Methods

Every method lives under the `dsh.` namespace; the aliases `ping` / `discover` / `ask` / `models` also work as
JSON-RPC method names.

### 3.1 Method table

| Method | Arguments | Returns |
| --- | --- | --- |
| `dsh.discover` | — | version, runtime config, transport, method catalogue |
| `dsh.ping` | — | `{ok, plugin, version, protocol, origin, tokenSource, activeRuns}` |
| `dsh.models` | — | `{default, routableProviders, groups[], failures[]}` |
| `dsh.workspaces.list` | — | `{total, items[]}` with id / title / path / status / session count |
| `dsh.workspaces.create` | `path, title?` | `{id, title, path}`; idempotent per path |
| `dsh.permissions.catalog` | — | `{options[], defaultPreset}`, each option carrying a `cost` line |
| `dsh.approvals.pending` | `sessionId?, waitMs?` | `{pending[], count, timedOut, mode, deadlineMs}` |
| `dsh.approvals.resolve` | `approvalId, decision, note?` | `{approvalId, sessionId, toolName, decision, note}` |
| `dsh.sessions.configure` | `sessionId, model?, reasoningEffort?, permissionPreset?` | the settings applied |
| `dsh.sessions.list` | `limit?, cwd?, sort?` | `{total, sort, cwd, items[]}` |
| `dsh.sessions.create` | `workspaceId? \| cwd?, agentPreset?, model?, reasoningEffort?, permissionPreset?` | `{sessionId, agentPreset, cwd, …}` |
| `dsh.sessions.ask` | see below | a turn result, or a handle with `wait:false` |
| `dsh.sessions.prompt` | `sessionId, text, mode?, model?, …` | `{accepted, sessionId, requestId, mode}`, returns at once |
| `dsh.sessions.wait` | `sessionId, timeoutMs?, since?` | a turn result |
| `dsh.sessions.cancel` | `sessionId` | `{accepted, sessionId}` |
| `dsh.sessions.history` | `sessionId, limit?` | `{cursor, turn, running, messageCount, records[]}` |

Semantics that are easy to get wrong:

- **`dsh.sessions.create` refuses `sessionId`**: the Host allocates ids; passing one is `-32602`, never a silent swap.
- **`dsh.sessions.list` usually reports `createdAt: null`**: measured here, the Host's `list()` only returns
  `updatedAt`, so sorting by `createdAt` degrades to host order.
- **`dsh.sessions.ask` defaults `wait` to `true`** (only the MCP tool `dsh_ask` defaults to `false` — protocol
  methods keep their shape across minors). A second bridge run on the same session gets `-32004`; add `queue: true`
  to wait its turn.
- **`dsh.sessions.prompt` does not hold the session**: it returns immediately and does not wait, so a concurrent
  `ask` can still take that turn — pair it with `dsh.sessions.wait`. Session-level settings such as `model` do apply
  here.
- **`limit` must be a positive integer**: `list` defaults to 50, `history` to 40 with a ceiling of 500. `0`,
  negatives or fractions return `-32602` instead of being quietly corrected.

`mode` is `turn` (default: deliver only when the session is idle; otherwise `-32004` plus `data.next`), `steer`
(inject into the running turn) or `queue` (start after the current turn). `turn` is the bridge's own rule — the
Host only knows `steer`/`queue`, so the bridge decides from a baseline snapshot before delivering. Anything else is
`-32602`, never a silent downgrade.

### 3.2 Turn result

`ask` (blocking) and `wait` return the same shape:

```jsonc
{
  "sessionId": "session-…",
  "turn": 2,
  "status": "completed",          // completed | aborted | blocked | error | max-tokens | interrupted | forked | idle | timeout | unknown | waiting-approval
  "reason": { "kind": "completed" },
  "text": "ok",                   // the turn's text; paragraphs joined by blank lines
  "reasoning": "…",               // optional
  "tools": [],                    // [{callId, name, arguments, output?, isError?}]
  "usage": { "inputTokens": 134981, "outputTokens": 2, "totalTokens": 134983 },
  "durationMs": 5311,
  "timedOut": false,
  "partial": false,               // true when the stream ended before turn/end; text is a fragment
  "sandbox": {                    // only when the turn was refused by the sandbox
    "denied": true,
    "marker": "[sandbox: file access denied under workspace-write mode]",
    "source": "tool"              // "tool" = read from tool output (reliable); "text" = only from the reply
  },
  "next": {                       // accompanies sandbox or waiting-approval
    "tool": "dsh_ask",
    "reason": "The turn was blocked by the DSH sandbox. …",
    "args": { "session_id": "session-…" }
  },
  "requestId": "rpc-…",
  "created": true,                // did this call create the session
  "cursor": 4,
  "since": 4,                     // present only if you passed since
  "turnStartedAt": 1793807450349
}
```

An `ask` with `wait:false` (**the MCP `dsh_ask` default**) returns a **handle** instead, with different fields:

```jsonc
{
  "sessionId": "session-…",
  "requestId": "rpc-…",
  "status": "running",
  "turn": null,                   // a handle carries no turn number
  "text": "",
  "accepted": true,
  "mode": "queue",                // delivered as queue or steer
  "created": false,
  "cwd": "…",
  "permissionPreset": "read-only"
}
```

Rules for reading results:

- `status` always comes from that turn's own `turn/end` reason. A cancelled turn is **never** reported as `completed`.
- If `turn/end` arrives **without a `reason`**, `status` is `unknown` and `reason` is
  `{kind:"unknown", message:"the Host ended the turn without a reason; treat this outcome as unverified"}`. `reason`
  is required in the TypeScript union but not checked at runtime — reporting an undescribable outcome as success is
  the hardest kind of bug to hunt.
- `timeout` means the wait expired; it does **not** cancel the turn. Those results have no `turn/end` to cite, so the
  bridge supplies `{kind:"timeout", message:"…it keeps running"}`.
- `partial: true` only appears with `status:"unknown"`: the event stream ended without `turn/end`, so `text` is a
  fragment.
- `cwd` is filled in only when `created:true`.
- `waiting-approval` appears only with `approvals.mode=delegate` while a turn waits for your answer — see 5.1.

Tool `output` is truncated at 4000 characters per call with a shared 20000-character budget per turn; excess is
replaced by `… (omitted, N chars: this turn's tool-output budget of 20000 is spent)`.

### 3.3 Waiting, deltas and deadlines

- **`since` returns only the delta**: without it you get the whole turn; with it you get events where `seq > since`
  and `text` covers just that slice, while `status`/`turn`/`tools`/`usage`/`sandbox` still describe the whole turn
  and `cursor` keeps advancing. Poll progress with `since: <last cursor>`; do not resend the prompt.
- **Waiting is a sliced loop**: one HTTP response cannot stay quiet for five minutes (Node's built-in fetch has a
  300-second `headersTimeout`; measured here: `fetch failed` at 303.9 s), so the bridge slices a wait into
  `maxWaitSliceMs` (default **120000**, ceiling 240000) and returns `status:"timeout"` with `sliceMs`/`requestedMs`
  for the caller to continue. **The CLI and the MCP tools already loop for you** — pass the total budget. If you
  write your own client, slice it yourself or never request more than 300 seconds.
- `waitedMs` is wall clock: the final slice is raised to a 1000 ms floor, so it can exceed the budget by up to a
  second; `slices` is the number of requests actually made.
- **The answer is written by our deadline, not by the Host**: every read races the run's deadline, and the closing
  cleanup (unregistering the event stream) waits at most one second — a stuck Host costs us one delay, not the
  answer.
- **"Not finished" is not a failure**: `status:"timeout"` only means this slice expired; the turn keeps running
  inside the Harness. Resending is re-asking, which creates sessions and repeats side effects. Use `wait`/`history`
  for progress.
- **Turn ownership**: after delivering the prompt the plugin looks for its own `user/message` in the stream
  (`source.rpcId` equals this call's `requestId`) and takes that turn as its own. So **when somebody else speaks in
  the same session, their answer is never mistaken for yours** — that `turn/end` is skipped and the bridge keeps
  waiting for its own.

### 3.4 Workspaces, models, effort, permissions

All four are DSH concepts; the bridge only forwards them and invents no new switches.

**Location (workspace vs directory) is decided at creation.** `workspaceId` goes through `workspace.attachSession`,
so the session shows up under that workspace in the GUI sidebar; `cwd` only sets the directory. They are mutually
exclusive and passing both is `-32602`. Passing a location again when reusing a session is refused too — a new
location means a new session. `agentPreset` behaves the same way.

Neither the CLI nor the MCP server pre-filters these: they forward what you give and let the bridge produce one
consistent refusal, so "passed but ignored" can never masquerade as "passed and applied".

```powershell
node bin/dsh-rpc.mjs workspaces                            # see what exists
node bin/dsh-rpc.mjs ask "look at this project" --workspace ws-1
node bin/dsh-rpc.mjs models | head -40
node bin/dsh-rpc.mjs ask "think again" --session session-xxxx --model anthropic/opus-4.6 --effort high
node bin/dsh-rpc.mjs permissions
node bin/dsh-rpc.mjs ask "run the tests" --permission workspace-write
```

**Model names** may be `provider/model`; a bare id is looked up in the catalogue — one match is used, several
produce an error listing the unambiguous spellings, none tells you to look at `dsh.models`. **It never guesses.**
`reasoningEffort` must accompany `model` in the same request: the Host has no "read back the current model" call.

> ⚠️ **Switching the model stores it as the profile default** (Host behaviour, same as switching in the GUI). After
> an external agent switches, sessions you open in the GUI will use that model too.

**Permission presets** bundle "sandbox mode + approval policy"; names are validated against the Host catalogue and
unknown ones are rejected with the options listed. Each carries a `cost` line because the deployment's own
`description` is often empty.

**Do not pass `permission` by default — escalate once only if you get blocked**:

1. The turn result carries `sandbox.denied: true` and `next`;
2. `next.args` carries only `session_id`: **deciding to re-ask with `danger-full-access` is yours to make**. The
   bridge neither decides for you nor stuffs that argument into the result (otherwise a blocked agent could talk its
   way into an escalation);
3. **Escalate once.** That preset's approval policy is `never`, so nothing blocks that turn afterwards — it is not a
   "wider default", it is the last resort when blocked, and you should say so in your answer.

With `approvals.mode=delegate` the gate stops the escalation before the tool runs and hands it to you (5.1) — then
you do not re-ask with another preset, you answer the pending request.

Why escalation must happen outside: DSH appends a hint that you may retry with `sandbox_permissions`, but a
bridge-driven session is unattended — under `approval: ask` there is no answerer, so the request normalises to
`unavailable` (which does not allow), and under `approval: never` the system prompt forbids asking at all. Both
roads are closed, so only the caller can re-ask under a different preset.

The ladder is a closed table: `read-only` may rise to `workspace-write` or `danger-full-access`, while
**`workspace-write` may only rise to `danger-full-access`** — there is no middle rung.

### 3.5 Streaming endpoint

`POST /dsh-rpc/stream` takes the same body as `ask` and answers one JSON per line:

```jsonc
{ "type": "session", "sessionId": "session-…", "cwd": "…", "agentPreset": null }   // only when created
{ "type": "progress", "frame": { "type": "event", "event": { "type": "turn/start" } } }
{ "type": "result", "sessionId": "session-…", "status": "completed" }              // last frame
{ "type": "error", "error": { "kind": "…", "message": "…" } }                      // or this frame
```

When the client disconnects, that wait is aborted (the Harness turn is not cancelled).

---

## 4. Error codes

Beyond the JSON-RPC standard codes, this plugin uses `-3200x` for business semantics:

| code | Meaning |
| --- | --- |
| `-32700` | body is not valid JSON |
| `-32600` | not a valid JSON-RPC request |
| `-32601` | unknown method |
| `-32602` | invalid arguments (missing field, empty text, bad sessionId…) |
| `-32603` | internal plugin error |
| `-32000` | Host-side failure (unclassified) |
| `-32001` | token missing or wrong |
| `-32002` | origin is not loopback and `allowRemote` is off |
| `-32003` | session not found (Host `session/not-found`) |
| `-32004` | session busy: Host `session/agent-busy` / `writer-held` / `conflict`, or another bridge run already waiting on it |
| `-32005` | wait timed out |
| `-32006` | call was cancelled |

`error.data` keeps the Host's own `kind` and `details`.

**MCP layer**: a tool result is an error **only when the call itself failed** (code plus a `next:` hint). A turn's
`status` always goes into the `outcome:` line; every end reason other than `completed` also gets a `note:` (plain
language) and a `next:` (what to do). An unknown `kind` is not an exception — the Host's `TurnEndReasonMap` is
merge-extensible, so such outcomes degrade to "unverified, check `dsh_sessions()` first" and never masquerade as
`completed`.

---

## 5. Configuration

Configured through the `config` block of a `cordis.patch.yml` row; every key has a default:

```yaml
- insert:
    - id: dsh-rpc-bridge
      name: '@punchact/dsh-rpc-agent'
      config:
        token: ''              # empty means generate and store one
        allowRemote: false     # accept non-loopback origins
        defaultCwd: ''         # used when ask has no cwd, then the process cwd
        defaultAgentPreset: '' # default preset for new sessions
        defaultTimeoutMs: 600000
        maxWaitSliceMs: 120000 # one response's wait length, see §8
        historyBudgetMs: 30000 # how long one history snapshot may take
        maxBodyBytes: 1048576
        maxSessions: 200       # concurrent waits
        approvals:
          mode: off            # off (default) | deny | delegate
          deadlineMs: 60000    # delegate: how long to wait for an answer
```

Other keys: `enabled`, `tokenFile`, `path` (default `/dsh-rpc`), `logRequests`.

`DSH_RPC_TOKEN` overrides the token (it wins over the file), which suits CI or hosts that should not write secrets
to disk.

### 5.1 Unattended sessions and escalations (`approvals`)

Sessions the bridge creates have nobody sitting in front of the GUI. As soon as a model asks for an escalation with
`sandbox_permissions`, the Host suspends that call waiting for an answer — **and how long it waits depends on
whether an answerer exists**, which a bridge-created session does not have. Measured twice on this machine:
`approval/asked` with no `approval/decided` afterwards, and the caller timing out against its 120-second budget
every time.

Three modes:

| Mode | Behaviour |
| --- | --- |
| `off` (default) | no gate; the Host's own fail-closed behaviour stands |
| `deny` | the bridge refuses in-place escalations in a `tools/pre-execute` gate |
| `delegate` | the decision goes to whoever dispatched the task |

**`deny`** only tightens, never widens: in sessions this bridge created, a call carrying `sandbox_permissions` is
refused before dispatch and the model immediately receives

```
approvals.mode=deny refused a sandbox escalation to "danger-full-access" for tool "pwsh"; the call was not executed.
```

Calls that do not escalate are untouched; sessions this process did not create (including ones a human is watching)
are passed through to their own answerers. Refusals are counted at `/status` under `calls.approvals.denied`.

**`delegate`** suspends the request and lets the caller answer with two methods:

| Method | Purpose |
| --- | --- |
| `dsh.approvals.pending({ sessionId?, waitMs? })` | list pending requests; `waitMs` turns it into a long poll of up to 120 seconds |
| `dsh.approvals.resolve({ approvalId, decision, note? })` | answer one: `allow-once` or `reject` |

The details that matter:

- **A turn waiting on you returns immediately**: `dsh_ask`/`dsh_wait` return `status: "waiting-approval"` plus
  `pendingApproval` and a `next` pointing at `dsh_approvals_resolve`. Otherwise the caller would be stuck answering
  a question it cannot see.
- **No answer is a refusal**: expiry at `deadlineMs` counts as reject; it never auto-allows.
- **Widening lasts only for the approved call**: the Host has no "allow once" interface, so the only lever is the
  session-level preset — after approval the bridge switches it and restores it the moment that call finishes
  (`tools/post-execute`), with a five-minute fallback timer. Downstream answerer throwing, result processing
  throwing, or the Host cancelling all restore it too; `dispose()` covers plugin unload.
- **Counted per session, at most 3**: only one escalated call may run per session at a time (concurrent requests in
  the same tick produce one pending record), and non-escalating calls during that window are **held** rather than
  allowed to ride along.
- **Only `workspace-write` and `danger-full-access` may be requested**; anything else is refused without asking.
- With `approvals.mode` not `off`, `dsh.sessions.configure` cannot push a session straight to `danger-full-access`,
  nor touch a session this bridge does not own.
- Allows and refusals are counted at `/status` under `calls.approvals.allowed` / `calls.approvals.denied`.

Decision packet fields: `approvalId` (random UUID, unguessable), `sessionId`, `toolName`, `callId`, `escalation`,
`argv` (command or path digest), `args` (the **whole argument object** as redacted JSON — credential-shaped values
masked, capped at 4000 characters), `argsTruncated`, `cwd`, `preset` (the session's **current** preset, null when
unreadable), `reason` (the sub-agent's own words, capped at 500 characters), `untrusted: true`, `createdAt`,
`expiresAt`.

**Across restarts**: the per-session allowances, the sessions this bridge owns, and any widening not yet restored
live in `$DSH_HOME/dsh-rpc/approvals.json` (0600, atomic `.tmp` + rename). A restart therefore does not reset
allowances and does not leave the gate deaf to older sessions; if the process is killed before restoring, the next
start reads the ledger and puts the preset back (failures only log a warning). Nothing is written while
`approvals.mode=off`.

> **Why not `ctx.on("approval/request")`**: the approval service dispatches through `scopeTarget(req.agent,
> req.agent)`, which only reaches answerers inside that agent's own composition. Measured: registering in both the
> plugin context and the root context, the listener **was never called** on a real escalation (the GUI panel was
> still waiting), whereas `tools/pre-execute` is a global waterfall covering every agent.

**Known edges**: only in-place escalations carrying `sandbox_permissions` are intercepted; `allow-once` is a
session-wide widening rather than a strictly single-use permit, so the 3-use cap is a guardrail rather than exact
accounting; a new session still gets a fresh three.

---

## 6. Install and update

**From npm (recommended).** This is a standard DSH bundle, so registry and local-directory installs share the same
pnpm path:

```bash
dsh plugin add @punchact/dsh-rpc-agent
```

Or from inside DSH:

```js
plugin_manager({ action: "install_bundle", target: "@punchact/dsh-rpc-agent" })
```

For a non-default profile add `--profile <name>` (`desktop` on the desktop app). To pin a version, spell it out:
`dsh plugin add @punchact/dsh-rpc-agent@0.7.7`; otherwise `latest` is used.

Three things that bite on the npm route:

1. **What lands is a copy, not a link.** Editing your workspace sources afterwards does **not** affect the running
   plugin. Use the local-directory route below if you want that.
2. **A fresh release may be held back by pnpm's release-age policy.** Installing by registry spec on release day
   fails while `minimumReleaseAge` is unmet. Either pin a version that has aged out, or allow it explicitly in the
   profile's `pnpm-workspace.yaml` — pnpm sometimes appends this line itself:

   ```yaml
   minimumReleaseAgeExclude:
     - '@punchact/dsh-rpc-agent@0.4.1 || 0.4.4 || 0.5.3 || 0.7.6 || 0.7.7'
   ```

3. **To see which copy is loaded**: call `cordis_inspect_query` (`Config.listConfigs`,
   `input: {"entry":"include:dsh-rpc-bridge"}`) and read `packageDir` — `<profile>\node_modules\@punchact\dsh-rpc-agent`
   means npm, your workspace means the link route. **The version string is not evidence**; it comes from whichever
   `package.json` was loaded.

Release history lives in [Releases](https://github.com/Punchact/dsh-rpc-agent/releases); **every version since 0.4.4
is published by OIDC with SLSA provenance**
(`/-/npm/v1/attestations/@punchact%2Fdsh-rpc-agent@<version>` returns 200). `0.4.1` / `0.4.2` were withdrawn and are
no longer on the registry.

**From a local directory (while editing)**:

```js
plugin_manager({ action: "install_bundle",
                 target: "<absolute-path-to-your-clone>" })
```

- This installs a **link** to that directory, so source edits need no reinstall.
- But the Host does not re-`import` on file changes; to pick up new `lib/*.mjs`, toggle the plugin row off and on:

```js
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: false })
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: true  })
```

`bin/` and `test/` are separate processes and need no reload. The release flow is documented in
[docs/release.md](./docs/release.md).

---

## 7. Security model

**In one sentence: this plugin's bearer token is permission to make DSH act on this machine.**

Any process holding the token can create sessions and deliver prompts, and DSH will then use **its own** tools to
read files, write files, run commands and reach the network — constrained by DSH's sandbox and approval policy, but
not by this plugin. The plugin does exactly two things: hand the request to the Host and hand the result back. It
widens no permission and reviews no content.

| Surface | Current state |
| --- | --- |
| Transport | loopback + Bearer token; only `127.0.0.1` / `::1` / `::ffff:127.0.0.1` by default, everything else 403 |
| Token storage | `%USERPROFILE%\.dsh\dsh-rpc\token`, 32 random bytes generated at first start, 0600 |
| Token comparison | SHA-256 plus timing-safe comparison, no byte-wise early return |
| Unauthenticated endpoint | `GET /health` returning `{ok, plugin, version, protocol, authenticated}` |
| Request body limit | 1 MiB (configurable); oversized bodies get 413 instead of being read into memory |
| Origin check | the socket's `remoteAddress`; `X-Forwarded-For` is ignored |

**Deliberately absent**: transport encryption (loopback only, no external interface bound), rate limiting, request
signing, and prompt logging (`logRequests` logs only headers when explicitly enabled).

**Exposing it to a LAN**: `allowRemote: true` merely disables the loopback allow-list and adds **no** authentication
strength. Such a deployment belongs behind a TLS-terminating proxy with its own access control.

**Shared machines**: the token file *is* the credential. Do not paste it into shell history, plaintext CI variables
or chat logs. If you suspect a leak, delete the file and reload the plugin — a new token is generated and the old
one stops working immediately.

---

## 8. Ports and connection stability

DSH's web server port is chosen by the launcher (the desktop app lets the OS pick), so it **changes after a
restart**. This plugin does not pin it.

**Why not hard-code it in the patch**: the `dsh-web-app` webserver row reads `ctx.webStartup.port ?? 3080` through
`!!js`, and a `cordis.patch.yml` override **replaces the whole config row** — hard-coding would mean restating
`host`, `tls`, `compression` and friends, and silently dropping any key an upstream upgrade adds. A pinned port also
blocks DSH entirely when it is taken.

**The plugin publishes the endpoint**: on each activation it calls `ctx.webServer.getOrigin()` and writes the real
address to `endpoint.json`; clients (CLI / MCP / `lib/client.mjs`) **re-read it on every call** and never cache.

**Only one error is retried during a restart window**: clients re-read the endpoint and retry once on
`ECONNREFUSED` (TCP refused, the request never left); `ECONNRESET` / `EPIPE` / timeouts are **not** retried, because
the bytes may already be accepted and a resend could deliver the prompt twice. An explicit `--url` or `DSH_RPC_URL`
is never retried either.

**Chaining commands across a restart**:

```powershell
node bin/dsh-rpc.mjs health --wait 15000; if ($?) { node bin/dsh-rpc.mjs ask "keep going" --session session-xxxx }
```

`--wait` re-reads the endpoint every 250 ms and probes until ready (exit 0 with the elapsed time), timing out with
exit 3.

**Cases that still fail**: the plugin not yet active while the Harness is starting (the `endpoint.json` still holds
the previous address), and multiple instances running at once (single file, last writer wins). Use `--url`
explicitly for both.

**After the caller disconnects**: a non-streaming request aborts when the socket closes — event iteration stops and
the run slot is released, but **the turn is not cancelled**. It keeps running in the Host and can still be collected
with `wait` (and is visible in the GUI). That is the difference between abort and cancel.

**How aborted calls are accounted**: under `calls.outcomes` in `/status`, not `errors` — `timeouts` means "the
budget ran out", `cancelledByClient` means "the caller left first".

---

## 9. Following a CLI task in the GUI

A CLI's stdout lives only in the terminal that ran it — that is the **caller's** output. But the turn being driven
**is a real Harness session**, so it also appears in the GUI:

| Layer | Where it shows up |
| --- | --- |
| CLI stdout / stderr / exit code | only the terminal that ran it |
| The session and its full transcript | the GUI sidebar; open it for transcript, tool calls, token usage |

This works because the plugin goes through the Host's `sessionController` rather than taking a bare agent: session
log, title generation and `running` state all come from the same store.

Three practical points:

1. **Always pass `--cwd`.** Without it the Host uses the process working directory (usually DSH's own profile
   directory), and such sessions are hard to place in the sidebar.
2. **Keep the returned `sessionId`.** Later `wait` / `history` / follow-ups / taking over in the GUI all need it.
3. **The GUI does not pop up on its own.** The session merely joins the list; you have to open it.

**Approvals remain with the GUI or your policy**: if a turn triggers a tool call that needs human approval, it
suspends on the Host side. With nobody opening the session it waits until `timeoutMs` runs out — `ask` then returns
`status:"timeout"` and **does not** cancel the turn (continue in the GUI, or call `dsh.sessions.cancel`).

---

## 10. Status panel in Settings

Once installed, the Settings window gains **“RPC Bridge”** (Settings → RPC Bridge). It answers "is the bridge alive,
and what did anyone call just now":

| Block | Content |
| --- | --- |
| Status light | online / unreachable, version, last refresh (the page polls every 2 seconds) |
| Runtime info | endpoint, protocol version, credential source, uptime, `pid`, Node version, remote allowed or not, total and failed calls |
| Running turns | each active `ask`/`wait`: first 8 characters of the run id, whether it has a session, whether it carries a prompt, elapsed time |
| Last 12 calls | time, method, duration, success/failure and error code |
| Per-method usage | counts and errors per method, plus the `timeouts` / `cancelledByClient` non-failure outcomes |
| How to connect | two copyable commands (MCP registration, one CLI try) |
| Config snippet | a `cordis.patch.yml` row built from the effective values, one click to copy |

It reads **`GET /dsh-rpc/status`**, which shares the `/health` trust boundary — **loopback only and no token**,
because a page in the browser cannot read the token in `endpoint.json`. In exchange that endpoint must say nothing:

- no token, no `sessionId` (active runs expose only the first 8 characters and whether a session exists);
- no call arguments at all — no prompt text, no tool parameters. Call accounting stores only **the method name, the
  duration and the result code**.

Everything on the page comes from that read-only endpoint; it writes nothing. To make the panel disappear, disable
the plugin — `/status` goes away with it.

> Port changes do not matter: the page asks for the fixed path `/dsh-rpc/status` (the plugin keeps that alias even
> when `path` is configured differently), and `origin` in the status payload is always the real listening address.

---

## 11. Verification

```powershell
cd dsh-rpc-plugin
npm test                       # all ten suites, 182 cases; needs neither a Harness nor npm install
node test/host.test.mjs        # 1 case: real-Host integration (run npm ci first)
node test/e2e.mjs --cwd .      # 14 cases: end to end against a live Harness
node test/edge.mjs             # 24 cases: protocol/edge adversarial, live Harness
```

What each of the ten suites pins down:

| Suite | Cases | Pins |
| --- | --- | --- |
| `methods` | 76 | turn ownership, steer, timeouts, abort reasons, history, cancel, argument contracts |
| `mcp-format` | 19 | result rendering: `note:` / `next:` / truncation / dedup / pending |
| `registry` | 8 | sticky-session table read/write, corrupt fallback, rotation |
| `pending` | 36 | pending store, long poll, cancellation reclaim, allowance reservation, transaction edges |
| `approvals` | 11 | config validation, the gate's deny/delegate branches, ownership, allow-list |
| `approval-state` | 8 | ledger across restarts, field-wise merge, TTL, orphan recovery |
| `wait` | 6 | sliced waiting (real HTTP stub) |
| `abort` | 7 | abort chain (real socket / in-process registry) |
| `client` | 6 | client retry and error reporting |
| `status` | 6 | `/status` payload and route-mount contract |

`npm test` runs those ten in a fixed order; `npm run test:host` runs the real-Host case; `npm run test:e2e` /
`npm run test:edge` need a live Harness.

**Do not use `node --test`**: it forks a child process per file, which a DSH sandbox blocks with `spawn EPERM`.

A few worth calling out:

- **Real-Host integration** uses no fake `webServer`: it starts a real listener with `new Context()` +
  `ctx.plugin(WebServer, {host:'127.0.0.1', port: 0})`, applies the plugin, then asserts over real HTTP that
  `/health` is 200, an unauthenticated RPC is 401, `/status`'s `origin` matches the listening address, **and finally
  runs the plugin's own disposer and asserts both routes turn 404**. It is the only test that catches the real
  incident where a previous generation's routes blocked a reload.
- **End to end** uses the same `lib/client.mjs` an external agent would, so green proves the whole chain: plugin →
  Host `sessionController` → HTTP → JSON-RPC → caller.
- **Edge** exercises the protocol layer: batch, notifications, id shapes, auth headers, oversized bodies (a real
  413, not a dropped connection), parameter-injection guards, timeout clamping, concurrent asks, `limit` semantics.
- **Port drift** (manual): point `endpoint.json` at a dead port and run `dsh-rpc ping`; expect exit 3 and a readable
  error mentioning `nothing is listening`, `pid` and `health --wait`.
- **Display check**: the plugin row's title and icon were confirmed by eye in the Plugins page (`RPC Bridge` plus
  this package's icon). `plugin_manager list_bundles` prints the `package.json` `description`, which is a different
  source from the UI label — not evidence that a locale took effect.

Last runs: unit 182/182 and host 1/1 (2026-11-06); end-to-end 14/14 and edge 24/24 (2026-11-05).

---

## 12. Known edges

- **One “asking” run per session**: a second concurrent `ask` gets `-32004` by default; with `queue: true` it queues
  (within its own `timeoutMs`, `-32005` on expiry) and shows as `state: "queued"` in `ping`/the status page. This only
  binds this plugin — the GUI or another agent can still speak up; ownership is claimed by `rpcId`, so someone else's
  answer is never mistaken for yours, at the cost of waiting for them to finish.
- **`wait` only sees the snapshot window**: it judges "current/last turn" from `follow`'s first frame, capped at 500
  events. A very long session whose snapshot was truncated before the target turn may report `completed`; call
  `history` with the `sessionId` for the exact value.
- **Batched requests run serially**: several JSON-RPC calls in one HTTP batch execute **in order**, so one slow
  `ask` blocks the rest. Use separate connections for concurrency.
- **Approval policy is not copied**: the Harness still applies its own sandbox and approval policy; a tool needing
  human approval can leave a turn suspended for a long time. `permissionPreset` sets a session default, it does not
  grant a pass.
- **Location is fixed at creation**: `workspaceId` / `cwd` do not apply to an existing session; the bridge refuses
  rather than ignoring them. A new location means a new session.
- **Switching models changes the profile default**: `selectModel` is the Host's model switch and stores the choice
  as the profile default.
- **Permission presets need an optional service**: without `permissionPresets`, passing `permissionPreset` yields
  `-32000` with an explanation.
- **Workspaces are create-only**: the bridge exposes `workspaces.list` / `workspaces.create`; rename and delete
  belong in the GUI.
- **Only Host-visible sessions are forwarded**: `sessions.list` and `history` pass through the Host's `remoteAccess`
  filter.
- **Text is truncated**: at most 4000 events are retained per turn; a very long session's `text` stays complete (it
  comes from `assistant/message`) but the `tools` array can be cut.
- **Token exposure surface**: the token sits alongside DSH's other credentials. **Sub-sessions created by this
  bridge can read it** — a sub-agent shares the same OS user, and a `workspace-write` sandbox may read the user
  directory (measured 2026-11-06: a sub-session read the token and called `dsh.ping` over `POST /dsh-rpc`). So
  `approvals.delegate` protects against **mistakes and prompt injection**, not against a process on the same machine
  and user deciding to escalate itself.
- **The approval gate covers one path**: `deny` / `delegate` intercept **`sandbox_permissions` inside tool
  arguments**. Changing a session's preset through `configure`, or choosing a preset when creating a session, takes
  another path — the former is blocked while `approvals.mode` is not `off`, but a preset chosen by the caller **at
  creation** is not constrained by the gate (that is the dispatcher's decision, not the sub-agent's).
- **No `Config` schema is declared**: the plugin validates the row's `config` by hand instead of exporting `Config`
  (to stay dependency-free). The cost is that `cordis_inspect_query` shows `status: absent` and there is no visual
  form; keys are listed in §5.

---

## 13. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `dsh-rpc: 401` | token mismatch. Delete `%USERPROFILE%\.dsh\dsh-rpc\token` and reload the plugin to regenerate |
| `403` | origin is not loopback; check for a proxy, or enable `allowRemote` |
| `-32004 … already has a bridge run waiting for its turn` | another `ask`/`prompt` is already waiting on that session; use another session or wait it out (`wait` can observe in parallel) |
| exit code `3` (cannot reach) | the Harness is not running, or the plugin row is disabled; probe with `node bin/dsh-rpc.mjs health` |
| source changed but behaviour did not | the Host cached the module: toggle with `set_plugin` off and on |
| source changed but behaviour did not (npm install) | the npm route installs a copy unrelated to your workspace; switch to the local-directory route |
| install reports release-age / version unavailable | a fresh release may still be inside `minimumReleaseAge`; pin an older version or allow it as in §6 |
| `Cannot read properties of undefined (reading 'throwIfAborted')` | an old version called Host `prompt/list` with `undefined`; fixed |
| plugin row status `absent` | expected: the plugin exports no `Config` schema, so there is no config contract to show |
