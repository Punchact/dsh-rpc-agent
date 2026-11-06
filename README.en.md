# dsh-rpc-agent

[中文](./README.md) · unofficial project

> The repository and the package are both named `dsh-rpc-agent`. The CLI names (`dsh-rpc`, `dsh-rpc-mcp`), the
> endpoint path (`/dsh-rpc`), the state directory (`~/.dsh/dsh-rpc`) and the `DSH_RPC_*` variables never change —
> they are the runtime contract, and renaming them would break every installed configuration and paired token.

Turns DeepSeek Harness into an **RPC service** any local agent can call: Claude Code, Codex CLI, Cursor, Trae, or
your own script hands DSH a task and gets its final answer back.

DSH is not a model here — it is a **complete agent**, with its own tools, skills, MCP servers, sandbox and session
context. The caller only needs one HTTP call or one MCP tool.

> **This project is not affiliated with DeepSeek.** It is a third-party plugin maintained independently, and it is
> neither endorsed nor supported by DeepSeek. Read §7 (security model) before you use it: holding this plugin's
> token is holding permission to drive DSH on this machine.

```
Claude Code / Cursor / Codex ──┐
dsh-rpc CLI ───────────────────┼──► http://127.0.0.1:<port>/dsh-rpc ──► DSH agent
your own script (lib/client) ──┘        JSON-RPC 2.0 + Bearer token
```

The port is **not fixed**: DSH picks one at each start and it changes after a restart. `node bin/dsh-rpc.mjs ping`
prints the current `origin`; the plugin also writes it to `endpoint.json`, which every client re-reads per call
(§8).

**Contents**: [1 Ways in](#1-four-ways-in) · [2 Endpoint and credentials](#2-endpoint-and-credentials) ·
[3 Methods](#3-methods) · [4 Error codes](#4-error-codes) · [5 Configuration](#5-configuration) ·
[6 Install and update](#6-install-and-update) · [7 Security model](#7-security-model) ·
[8 Ports and stability](#8-ports-and-connection-stability) ·
[9 Following a task in the GUI](#9-following-a-cli-task-in-the-gui) ·
[10 Status panel](#10-the-status-panel-in-settings) · [11 Verify](#11-verify) · [12 Known edges](#12-known-edges) ·
[13 Troubleshooting](#13-troubleshooting)

**Other docs**: [Changelog](./CHANGELOG.md) · [Security policy](./SECURITY.md) ·
[Release handbook](./docs/release.md) · [Design notes](./docs/design.md)

**Version**: the latest published version on npm is
[`0.7.6`](https://www.npmjs.com/package/@punchact/dsh-rpc-agent) (`npm view @punchact/dsh-rpc-agent version`; the
registry can lag a minute or two right after a publish). This file describes the **code in the repository**; the
difference between the two is at the top of [CHANGELOG](./CHANGELOG.md).

---

## 1. Four ways in

| Way | Good for | Entry point |
| --- | --- | --- |
| **MCP tools** | agents that speak MCP: Claude Code, Cursor, Codex | `bin/dsh-rpc-mcp.mjs` |
| **CLI** | trying things by hand, `$(...)` in scripts | `bin/dsh-rpc.mjs` |
| **HTTP JSON-RPC** | a process in any language | `POST http://127.0.0.1:<port>/dsh-rpc` |
| **JS client library** | Node-side integration | `import { rpcCall, rpcStream } from "@punchact/dsh-rpc-agent/http-client"` |

### MCP (recommended)

`bin/` means the `bin/` **inside the package**. When installed from npm (the recommended route in §6, default
`desktop` profile) it lives at:

```powershell
claude mcp add dsh -- node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\bin\dsh-rpc-mcp.mjs"
```

Cursor / Codex use the same path in their config file (escape the backslashes in JSON):

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

If you installed from a local clone instead, swap the path for `<path-to-your-clone>\bin\dsh-rpc-mcp.mjs`; the CLI
examples below are written `node bin/...`, which means "run it from inside the package".

Nine tools: `dsh_ask`, `dsh_workspaces`, `dsh_permissions`, `dsh_sessions`, `dsh_wait`, `dsh_cancel`, `dsh_status`,
`dsh_approvals_pending`, `dsh_approvals_resolve`. The first line of every result is `session <id>`, then the body,
then one `— outcome: … · turn … · 5.2s` metadata line.

Tool arguments are snake_case (the MCP convention), unlike the HTTP layer:

| Tool | Arguments | Notes |
| --- | --- | --- |
| `dsh_ask` | `prompt` (**required**), `project?`, `reuse?`, `mode?`, `wait?`, `session_id?`, `cwd?`, `workspace_id?`, `agent_preset?`, `model?`, `reasoning_effort?`, `permission?`, `timeout_ms?` | Ask one turn. **`wait` defaults to `false`**: you get a handle (with `session_id`) immediately and collect the answer with `dsh_wait`; `wait:true` blocks for that turn. `project` is the sticky-session key (see below). `cwd` and `workspace_id` are mutually exclusive; both, and `agent_preset`, only apply when a session is created — passing them together with `session_id` is rejected |
| `dsh_workspaces` | `path?`, `title?` | With no `path`, list workspaces; with one, register it |
| `dsh_permissions` | — | List permission presets and the default |
| `dsh_sessions` | `limit?`, `cwd?`, `sort?` | List sessions; `cwd` filters by path prefix, `sort` takes `updatedAt` (default) or `createdAt`, newest first. When the Host reports no creation time, `createdAt` is always `null` and `sort:"createdAt"` falls back to the Host's own order |
| `dsh_wait` | `session_id` (required), `timeout_ms?`, `since?` | Wait for the current/next turn; `since` returns only the body after that cursor (a delta) |
| `dsh_cancel` | `session_id` (required) | Interrupt the running turn |
| `dsh_status` | — | Same as `ping`: check the endpoint and token |
| `dsh_approvals_pending` | `session_id?`, `wait_ms?` | List sandbox escalations waiting for you; `wait_ms` turns it into a long poll (≤120 s) |
| `dsh_approvals_resolve` | `approval_id`, `decision` (`allow-once` \| `reject`), `note?` | Answer one pending escalation |

> A misspelled argument says so plainly: passing `text` to `dsh_ask` yields `` `prompt` is required `` with
> `isError:true`.

> The MCP server and the Harness session it drives **do not share context**. Prompts have to be self-contained.

### Sticky sessions (0.5.0)

`dsh_ask` without `session_id` no longer creates a session blindly: it looks up
`${clientName}::${project ?? cwd}` in `~/.dsh/dsh-rpc/sessions.json`, and if the session still exists and is not
blank it **continues in that one**; otherwise it creates a session and records it. So the second call for the same
`project` lands in the same session — that is how "one project, one session" works in practice.

| Argument | Values | Meaning |
| --- | --- | --- |
| `project` | any stable label (repo name, ticket id) | Sticky key; falls back to `cwd` |
| `reuse` | `auto` (default) / `never` / `latest` | `auto` uses the recorded session; `never` always creates; `latest` ignores the recorded id and takes the project's most recent session by `updatedAt` |

Two edges: **different clients never share** (`clientInfo.name` from `initialize` is part of the namespace), and
**there is no fallback that fakes a session** — if the recorded one was deleted or is still blank, the bridge creates
a new one instead of failing. The table lives on the bridge side, written atomically with `0600`; a corrupt file just
means "no records", never a failed call.

A single session becomes a context burden over time, so after **200** `ask` calls on the same key the bridge
rotates: it creates a new session and reports the old id as `previousSessionId` with `rotated: true`. That counter
counts **this bridge's deliveries**, not the Host's messages — the Host has no cheap counter.

### CLI

```powershell
node bin/dsh-rpc.mjs health            # unauthenticated liveness probe
node bin/dsh-rpc.mjs health --wait 15000  # poll until ready (right after a restart)
node bin/dsh-rpc.mjs ping              # a real call with the token
node bin/dsh-rpc.mjs workspaces        # workspaces shown in the DSH sidebar
node bin/dsh-rpc.mjs permissions       # permission presets (* marks the default)
node bin/dsh-rpc.mjs ask "只回复两个字：收到" --cwd . --json
node bin/dsh-rpc.mjs ask "看看这个工作区" --workspace ws-xxxx --json
node bin/dsh-rpc.mjs ask "接着上一句" --session session-xxxx --json
node bin/dsh-rpc.mjs ask "换 Opus 想想" --session session-xxxx --model anthropic/opus-4.6 --effort high
node bin/dsh-rpc.mjs prompt "长时间任务…" --session session-xxxx
node bin/dsh-rpc.mjs wait --session session-xxxx --timeout 600000
node bin/dsh-rpc.mjs wait --session session-xxxx --since 42      # only the delta after cursor 42
node bin/dsh-rpc.mjs call dsh.sessions.history '{"sessionId":"session-xxxx"}' --timeout 30000
node bin/dsh-rpc.mjs cancel --session session-xxxx
node bin/dsh-rpc.mjs history --session session-xxxx --limit 20
node bin/dsh-rpc.mjs models            # models DSH can route to
node bin/dsh-rpc.mjs sessions --limit 10
node bin/dsh-rpc.mjs discover          # self-description: methods, transport, result shape
node bin/dsh-rpc.mjs call dsh.sessions.list '{"limit":3}'
```

Exit codes: `0` done · `1` failed or the turn did not end cleanly · `2` usage error · `3` cannot reach the Harness.

### HTTP

```powershell
$endpoint = (Get-Content "$env:USERPROFILE\.dsh\dsh-rpc\endpoint.json" -Raw | ConvertFrom-Json).url
$token    = (Get-Content "$env:USERPROFILE\.dsh\dsh-rpc\token" -Raw).Trim()
$body = @{ jsonrpc = "2.0"; id = 1; method = "dsh.sessions.ask";
           params = @{ text = "只回复两个字：收到"; cwd = "C:\path\to\work" } } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri $endpoint `
  -Headers @{ Authorization = "Bearer $token" } -ContentType application/json -Body $body
```

(`endpoint.json` is rewritten at every start, so reading the address this way never needs the port.)

### JavaScript

```js
import { rpcCall } from "@punchact/dsh-rpc-agent/http-client";

const answer = await rpcCall("dsh.sessions.ask", { text: "总结一下这个仓库", cwd: process.cwd() });
console.log(answer.text, answer.usage);
```

That subpath is declared in `exports` (`"./http-client": "./lib/client.mjs"`). From npm, import it as above; in a
local clone it is `import … from "<path-to-your-clone>/lib/client.mjs"`.

`rpcCall` resolves to the method's `result`; failures throw an `Error` carrying `code` / `data` / `status`, so you
can branch on the error code directly.

---

## 2. Endpoint and credentials

| Item | Value |
| --- | --- |
| RPC endpoint | `POST http://127.0.0.1:<port>/dsh-rpc` (JSON-RPC 2.0) |
| Streaming endpoint | `POST http://127.0.0.1:<port>/dsh-rpc/stream` (NDJSON) |
| Liveness | `GET http://127.0.0.1:<port>/dsh-rpc/health` (**no auth**) |
| Credential | `Authorization: Bearer <token>`, or `X-DSH-RPC-Token: <token>` |
| Token file | `%USERPROFILE%\.dsh\dsh-rpc\token` (32 random bytes in hex, mode 0600) |
| Endpoint descriptor | `%USERPROFILE%\.dsh\dsh-rpc\endpoint.json` (rewritten at every start) |

`<port>` is chosen by DSH and can differ after each start. `endpoint.json` looks like this:

```jsonc
{
  "url": "http://127.0.0.1:3820/dsh-rpc",
  "origin": "http://127.0.0.1:3820",
  "path": "/dsh-rpc",
  "version": "0.7.6",                        // the version the running plugin reports
  "plugin": "dsh-rpc-agent",
  "pid": 12345,                              // the Host process that wrote this file
  "startedAt": "2026-11-05T01:05:58.000Z",   // when that process started
  "updatedAt": "2026-11-05T01:06:31.924Z"    // when this file was written
}
```

`pid` and `startedAt` let a client tell "the Harness restarted" from "the port moved": if both are unchanged and
the call still fails, it is not port drift.

- **The token is generated automatically** on first activation and written to disk; the CLI/MCP read it, nothing to
  configure by hand.
- **Loopback only** by default: `127.0.0.1` / `::1` / `::ffff:127.0.0.1`, everything else is 403. Opening it to a
  LAN requires `allowRemote` (see §5).
- **The liveness probe is deliberately unauthenticated**: it only returns
  `{ok, plugin, version, protocol, authenticated}` and leaks no session or configuration.

---

## 3. Methods

All method names live under the `dsh.` namespace; the CLI aliases `ping` / `discover` / `ask` / `models` also work as
JSON-RPC method names.

| Method | Arguments | Result |
| --- | --- | --- |
| `dsh.discover` | — | Plugin version, runtime config (`defaultTimeoutMs`, `maxWaitSliceMs` plus `maxWaitSliceMsRequested` when clamped, `historyBudgetMs`), transport addresses, method catalogue |
| `dsh.ping` | — | `{ok, plugin, version, protocol, origin, tokenSource, activeRuns}` |
| `dsh.models` | — | `{default, routableProviders, groups[], failures[]}` |
| `dsh.workspaces.list` | — | `{total, items:[{id, title, path, status, sessions, createdAt, updatedAt}]}`, `status` is `ok` / `missing-dir` / `unknown` |
| `dsh.workspaces.create` | `path, title?` | `{id, title, path}`: register a directory as a workspace (idempotent per path) |
| `dsh.permissions.catalog` | — | `{options:[{value, name, description?, cost?}], defaultPreset}`: each preset is a sandbox mode plus an approval policy |
| `dsh.approvals.pending` | `sessionId?`, `waitMs?` | `{pending:[{approvalId, sessionId, toolName, escalation, argv, args, argsTruncated, cwd, preset, reason, untrusted, createdAt, expiresAt}], count, timedOut, mode, deadlineMs}`: escalations waiting for you when `approvals.mode=delegate`; `waitMs` makes it a long poll (≤120 s) |
| `dsh.approvals.resolve` | `approvalId`, `decision`, `note?` | `{approvalId, sessionId, toolName, decision, note}`: answer one |
| `dsh.sessions.configure` | `sessionId, model?, reasoningEffort?, permissionPreset?` | `{sessionId, selected?, permissionPreset?}`: change model / effort / permission of an existing session |
| `dsh.sessions.list` | `limit?, cwd?, sort?` | `{total, sort, cwd, items:[{sessionId, running, blank, cwd, updatedAt, createdAt, …}]}`. `cwd` filters by prefix, `sort` takes `updatedAt` (default) or `createdAt`, newest first. **Measured here: the Host's `list()` only has `updatedAt`**, so `createdAt` is `null` and sorting by it keeps the Host's order |
| `dsh.sessions.create` | `workspaceId? \| cwd?, agentPreset?, model?, reasoningEffort?, permissionPreset?` | `{sessionId, agentPreset, cwd, selected?, permissionPreset?}`. `workspaceId` and `cwd` are exclusive; with neither, the Host decides and `cwd` reports where it landed. **Does not accept `sessionId`** — the Host assigns ids, and passing one is `-32602`, never a silent swap |
| `dsh.sessions.ask` | `text, sessionId?, project?, reuse?, namespace?, workspaceId? \| cwd?, agentPreset?, model?, reasoningEffort?, permissionPreset?, mode?, queue?, timeoutMs?, wait?` | See **Turn results** below. Without `sessionId` it reuses or creates via the sticky table (`namespace::project ?? cwd`) and reports `created`/`reused`/`rotated`. **The RPC default for `wait` is still `true`** (only the MCP tool defaults to `false`). If this bridge already has a run waiting on the session it returns `-32004` unless you pass `queue: true`, which queues behind that turn (bounded by your own `timeoutMs`) |
| `dsh.sessions.prompt` | `sessionId, text, mode?, model?, reasoningEffort?, permissionPreset?` | `{accepted, sessionId, requestId, mode, selected?, permissionPreset?}`: returns immediately, does not wait. **Does not hold the session**, so a concurrent `ask` can still take the turn — pair it with `dsh.sessions.wait`. Session-level settings such as `model` take effect here too (this is what `CLI prompt --model` uses) |
| `dsh.sessions.wait` | `sessionId, timeoutMs?, since?` | Wait for the session's **current or next** turn and return its result; `since` returns only events after that cursor (for delta polling) |
| `dsh.sessions.cancel` | `sessionId` | `{accepted, sessionId}`: interrupt the running turn, keep the queue |
| `dsh.sessions.history` | `sessionId, limit?` | `{cursor, turn, running, messageCount, records[]}`: read-only snapshot |

`mode` takes `turn` (default: deliver only when the session is idle; otherwise `-32004` with `data.next`), `steer`
(join the running turn, effective after the current step) or `queue` (start when the current turn ends). `turn` is
the bridge's own criterion — the Host only knows `steer` / `queue`, so the bridge checks a baseline snapshot first
and only delivers when it reads idle. Any other value is `-32602`; nothing silently degrades to a different
concurrency meaning.

`limit` must be a positive integer: `dsh.sessions.list` defaults to 50, `dsh.sessions.history` to 40, and `history`
caps at 500. `0`, a negative number or a fraction is `-32602`, not a quietly corrected count.

### Workspaces, models, reasoning effort, permissions

These four are DSH concepts; the bridge only forwards them and invents no new switches.

**Location (workspace or directory) is decided at creation only.** `workspaceId` goes through
`workspace.attachSession`, so the session appears under that workspace in the GUI sidebar; `cwd` only sets a
directory. They are mutually exclusive and passing both is `-32602`. Passing location arguments when reusing a
session is rejected too — a new location means a new session. Same for `agentPreset`: it selects the agent preset
and only applies at creation.

Neither the CLI nor MCP filters these client-side: they are forwarded and the bridge gives one consistent reason.
That way "passed but ignored" can never masquerade as "passed and applied".

```powershell
node bin/dsh-rpc.mjs workspaces                        # see what is available
node bin/dsh-rpc.mjs ask "看下这个项目" --workspace ws-1   # work inside one
```

**Model and reasoning effort** go through `dsh.sessions.configure` or the same-named creation arguments, and land on
the Host's `selectModel`:

```powershell
node bin/dsh-rpc.mjs models | head -40
node bin/dsh-rpc.mjs ask "重新想想" --session session-xxxx --model anthropic/opus-4.6 --effort high
```

- A model may be written `provider/model`; a bare id is looked up in the catalogue — one match is used, several
  produce an error listing the disambiguating forms, zero tells you to check `dsh.models`. **It never guesses.**
- `reasoningEffort` must be given in the same request as `model`; the Host has no "read back the current model"
  call, and the bridge does not guess.
- ⚠️ **Changing the model stores it as the profile default** (Host behaviour, same as switching in the GUI). After an
  external agent switches, new GUI sessions use that model too.

**A permission preset** is "sandbox mode + approval policy" bundled: picking one sets both knobs.

```powershell
node bin/dsh-rpc.mjs permissions
node bin/dsh-rpc.mjs ask "跑一下测试" --permission workspace-write
```

Preset names are validated against the Host catalogue; unknown names error out and list the options. Every entry in
`dsh.permissions.catalog` carries a `cost` sentence, because the deployment-provided `description` is usually empty.

**Do not pass `permission` by default; escalate once after hitting the sandbox:**

1. The bridge reports `sandbox.denied: true` and `next` in that turn's result;
2. `next.args` carries only `session_id`: **re-asking with `danger-full-access` is your decision**. The bridge
   neither decides for you nor stuffs that argument into the return value (otherwise a blocked agent could talk its
   own way into an escalation);
3. **Escalate once.** That preset's approval policy is `never`, so nothing intercepts afterwards — a last resort, not
   a wider default, and the answer should say it was used.

If `approvals.mode` is `delegate`, the gate stops the escalation before the tool runs and hands it to you (see
§5); then you do not re-ask with another preset, you answer the request.

Why escalation has to happen outside: DSH appends "you may retry with `sandbox_permissions`" to a denial, but a
bridge-driven session is unattended — with `approval: ask` there is no answerer, so the request normalises to
`unavailable` (no permission), and with `approval: never` the system prompt forbids asking for an escalation. Both
routes are closed, so the caller changes the preset and asks again.

The sandbox escalation ladder is a closed table: `read-only` may go to `workspace-write` or `danger-full-access`,
while **`workspace-write` may only go to `danger-full-access`** — there is no middle rung.

### Turn results (`ask` / `wait`)

```jsonc
{
  "sessionId": "session-…",
  "turn": 2,
  "status": "completed",          // completed | aborted | blocked | error | max-tokens | interrupted | forked | idle | timeout | unknown | waiting-approval
  "reason": { "kind": "completed" },
  "text": "收到",                 // this turn's body; parts joined by blank lines
  "reasoning": "…",               // optional
  "tools": [],                    // [{callId, name, arguments, output?, isError?}]; output cut at 4000 chars each, 20000 per turn
  "usage": { "inputTokens": 134981, "outputTokens": 2, "totalTokens": 134983 },
  "durationMs": 5311,
  "timedOut": false,
  "partial": false,               // true when the stream ended before turn/end; text is only a fragment
  "sandbox": {                    // only when a step was blocked by the sandbox
    "denied": true,
    "marker": "[sandbox: file access denied under workspace-write mode]",
    "source": "tool"              // "tool" = read from tool output (reliable); "text" = only from the agent's prose (it may be quoting)
  },
  "next": {                       // only with sandbox: the one documented way out
    "tool": "dsh_ask",
    "reason": "The turn was blocked by the DSH sandbox. … caller's decision …",
    "args": { "session_id": "session-…" }   // the permission is the caller's decision, not supplied here
  },
  "requestId": "rpc-…",
  "created": true,                // whether this call created the session
  "cursor": 4,
  "since": 4,                     // only when since was passed: every event here is > since
  "turnStartedAt": 1793807450349
}
```

`ask` with `wait:false` (**the default for the MCP tool `dsh_ask`**) does not wait; it returns a **handle**:

```jsonc
{
  "sessionId": "session-…",
  "requestId": "rpc-…",
  "status": "running",            // not finished yet
  "turn": null,                   // no turn number in a handle; you learn it from wait
  "text": "",
  "accepted": true,
  "mode": "queue",                // delivered as queue or steer
  "created": false,
  "cwd": "…",
  "permissionPreset": "read-only"           // when a preset was applied
}
```

- `status` always comes from that turn's own `turn/end` reason; a cancelled turn is **never** reported `completed`.
- If `turn/end` carries **no `reason`**, `status` is `unknown` and `reason` is
  `{kind:"unknown", message:"the Host ended the turn without a reason; treat this outcome as unverified"}`. The type
  says `reason` is required, but that is a TypeScript union, not a runtime check — reporting an indescribable ending
  as success is the hardest kind of bug to chase.
- `timeout` means the wait expired; it **does not cancel the turn**. Such a result has no `turn/end` to quote, so the
  bridge supplies `reason: {kind:"timeout", message:"…it keeps running"}` instead of leaving it empty.
- `partial: true` only appears with `status:"unknown"`: the event stream ended before `turn/end`, so `text` is a
  fragment — do not treat it as the answer.
- `cwd` is echoed only when `created:true`.
- `sandbox.denied` **only recognises the fixed marker the Host writes into tool output**
  (`[sandbox: file access denied`), never synonyms in the prose; if no tool output is available it falls back to
  scanning the body. Better to miss than to misreport.
- `sandbox` and `next` are not errors: `status` and tool-error classification are unaffected — the turn did finish,
  one step was blocked. Follow `next`, **do not** retry with the same preset and do not open a new session.
- **Handles do not occupy the turn slot** and are not registered as a bridge run waiting on the session, so there is a
  millisecond-wide window between the handle returning and `dsh_wait` taking over; a second `ask` on that session in
  that window is refused with `-32004` rather than silently queued.
- `queue: true` and `wait: false` contradict each other (the first wants to wait for the slot, the second does not
  wait at all). Passing both is `-32602`, not a silent preference for one.
- `since` makes `wait` return a delta: omit it for the whole turn, pass a cursor for only `seq > since` events, with
  `text` narrowing accordingly; `status`/`turn`/`tools`/`usage`/`sandbox` still describe the whole turn, and `cursor`
  keeps advancing. For progress polling use `since: <last cursor>` — never resend the prompt.
- **Waiting is a sliced loop**: a single HTTP response cannot stay quiet past five minutes (Node's built-in fetch has
  a 300 s `headersTimeout`; measured: `fetch failed` at 303.9 s). So the bridge slices a wait into `maxWaitSliceMs`
  (default **120000**, capped at 240000 — a larger value is clamped with a warning), returning `status:"timeout"` with
  `sliceMs`/`requestedMs` so the caller continues. **The CLI and the MCP tools already loop for you**; pass the total
  budget. If you write your own client, slice it yourself or never ask for more than 300 s. `waitedMs` is wall clock:
  a trailing slice is lifted to the 1000 ms floor, so it can exceed the budget by up to a second, while `slices` is
  the true number of requests.
- **Our deadline writes the answer, not the Host**: every frame read races this run's deadline, and the closing
  cleanup (deregistering from the Host's event stream) waits at most one second — a stuck Host can slow us down once,
  but it cannot hold the answer. This is the direct fix for a `wait` that once sat 13 minutes.
- **One `history` snapshot is bounded too**: `historyBudgetMs` (default **30000**, clamped to 100..120000) ends the
  read with `-32005` rather than hanging, and closing the stream afterwards waits at most a second.

**How the MCP layer renders it** (`bin/dsh-rpc-mcp.mjs` + `lib/mcp-format.mjs`): a tool result is an error **only
when the call itself failed** (error code plus a `next:` hint). A turn's `status` always goes into the body's
`outcome:` line, and **every ending adds a `note:` (plain language) and a `next:` line — only `completed` has
neither**:

```
session session-a
— outcome: aborted · turn 5 · 12.3s · 3 tool calls · cursor 88
note: the turn was stopped (cause: user — the Host cannot tell a bridge cancel from someone pressing stop)
reason: {"kind":"aborted","reason":{"kind":"user"}}
next: do not resend blindly: ask the human whether to continue, then resend with the same session_id
```

`aborted` / `blocked` / `error` / `max-tokens` / `interrupted` / `forked` / `refusal` / `unknown` each have their own
wording: `aborted` names who stopped it (`user` / `parent` / `hook{reason}` / `disposed` / `legacy`), `error` joins
the `LlmFailure` `code` and `message` into "this is not a tool failure", `max-tokens` warns the next attempt will be
cut too. **A `kind` this plugin does not know is not an exception** — the Host's `TurnEndReasonMap` is
merge-extensible (source comment: `a backend-added variant cannot be listed`), so such endings degrade to
"unverified, check `dsh_sessions()` first" and never pretend to be `completed`.

While still running, the collection hint is still given:

```
next: the turn is still running — do NOT resend the prompt. Call dsh_wait({ session_id: "…", timeout_ms: 600000, since: 31 }) to collect it.
```

`partial` **no longer claims "still running"** (it only says the stream had no `turn/end`; the Host may be gone): its
`next:` asks you to check `dsh_sessions()` first, then decide between `dsh_wait` and resending.

This text is for the caller's model: **"not ready yet" is not failure, and resending equals re-asking.** You cannot
decide by `status` alone — it is the Host's free-form string (`reason.kind` passed through), and any allow-list will
miss something.

**Turn attribution**: `ask` does not merely guess "baseline turn + 1". After delivering the prompt the plugin finds
its own `user/message` (whose `source.rpcId` equals this request's `requestId`) and takes that turn as the one it
owns. So **if someone else (the GUI or another agent) speaks first in the same session, their answer is not reported
as yours** — that turn's `turn/end` is skipped and the wait continues.

### Streaming endpoint

`POST /dsh-rpc/stream`, same body as `ask`, response is NDJSON — one JSON object per line:

```jsonc
{ "type": "session", "sessionId": "session-…", "cwd": "…", "agentPreset": null }   // only when a session was created
{ "type": "progress", "frame": { "type": "event", "event": { "type": "turn/start", … } } }
{ "type": "result", …turn result fields, "created": false }                        // final frame
{ "type": "error", "error": { "kind": "…", "message": "…" } }                      // or this frame
```

If the client hangs up, that wait is aborted (the Harness turn is not cancelled).

---

## 4. Error codes

Beyond the JSON-RPC standard codes, business meaning uses the `-3200x` range:

| code | Meaning |
| --- | --- |
| `-32700` | Body is not valid JSON |
| `-32600` | Not a valid JSON-RPC request |
| `-32601` | Unknown method |
| `-32602` | Invalid arguments (missing field, empty text, bad sessionId, …) |
| `-32603` | Plugin internal error |
| `-32000` | Host-side failure (uncategorised) |
| `-32001` | Token missing or wrong |
| `-32002` | Origin is not loopback and `allowRemote` is off |
| `-32003` | Session not found (Host `session/not-found`) |
| `-32004` | Session busy: Host `session/agent-busy`, `session/writer-held`, `session/conflict`, or another bridge run already waiting on this session (so someone else's answer is not reported as yours) |
| `-32005` | Wait timed out |
| `-32006` | Call cancelled |

`error.data` keeps `kind` (the Host's original code, e.g. `session/not-found`) and `details`.

---

## 5. Configuration

Configured through the `config` row of `cordis.patch.yml`; everything has a default, an empty object is fine:

```yaml
- insert:
    - id: dsh-rpc-bridge
      name: '@punchact/dsh-rpc-agent'
      config:
        token: ''              # empty = generate and persist one
        allowRemote: false     # accept non-loopback origins (off by default)
        defaultCwd: ''         # used when ask has no cwd, before the process cwd
        defaultAgentPreset: '' # default preset for new sessions
        defaultTimeoutMs: 600000
        maxWaitSliceMs: 120000 # length of one response's wait, see §8
        historyBudgetMs: 30000 # how long one history snapshot may take
        maxBodyBytes: 1048576
        maxSessions: 200       # concurrent waits allowed
        approvals:
          mode: off            # off (default) | deny | delegate
          deadlineMs: 60000    # delegate: how long the caller gets, expiry counts as a refusal
```

Other keys: `enabled`, `tokenFile` (custom token path), `path` (default `/dsh-rpc`), `logRequests`.

### Unattended sessions and approvals (`approvals.mode`)

Sessions this bridge creates have nobody sitting in front of the GUI. The moment the model asks for an escalation by
passing `sandbox_permissions`, the Host suspends that call waiting for an answer — **how long depends on whether an
answerer exists**, and a bridge-created sub-session has none. Observed twice in the field: `approval/asked` with no
`approval/decided` ever, and the caller timing out at its 120 s budget every time.

- `off` (default): the bridge installs no gate and keeps the Host's own fail-closed behaviour.
- `deny`: the bridge installs a `tools/pre-execute` gate that **only refuses in-place escalation**. In sessions this
  bridge created, a call carrying `sandbox_permissions` is refused before dispatch and the model immediately gets:
  `approvals.mode=deny refused a sandbox escalation to "danger-full-access" for tool "pwsh"; the call was not executed.`
  It **only tightens, never widens**: calls without escalation are untouched, and sessions this process did not create
  (including ones a human is watching) pass through to their own answerer. Refusals are counted in `/status` as
  `calls.approvals.denied`.
- `delegate`: the decision goes to **the caller that dispatched the task**. An escalation is held and the caller
  answers with two methods:

  | Method | Purpose |
  |---|---|
  | `dsh.approvals.pending({ sessionId?, waitMs? })` | List pending requests; `waitMs` turns it into a long poll of up to 120 s |
  | `dsh.approvals.resolve({ approvalId, decision: "allow-once"\|"reject", note? })` | Answer one |

  - **A turn held on an approval answers immediately**: with `delegate`, if this turn stopped because it is waiting for
    you, `dsh_ask`/`dsh_wait` do not block until `deadlineMs` — they return `status: "waiting-approval"` with
    `pendingApproval` (and a `next` pointing at `dsh_approvals_resolve`). Otherwise the caller is stuck in a loop
    answering its own question and never even sees it.
- **A widening lasts only as long as the approved call**: a throwing downstream answerer, a throwing result handler and
  a Host cancellation all restore the preset (`dispose()` covers plugin unload); the same session accepts no second
  escalation while the window is open, and other non-escalating calls are **held** until it closes so nobody rides
  along. When `approvals.mode` is not `off`, `dsh.sessions.configure` can neither jump a session straight to
  `danger-full-access` nor touch a session this bridge does not own.

Decision packet fields: `approvalId` (random UUID, not enumerable), `sessionId`, `toolName`, `callId`, `escalation`,
`argv` (redacted command or path digest), `args` (**the whole argument object** as redacted JSON — credential-shaped
values masked, capped at 4000 chars), `argsTruncated`, `cwd`, `preset` (the session's **current** preset, `null` when
unreadable), `reason` (the sub-agent's own words, truncated to 500 chars), `untrusted: true` (a reminder that `reason`
is what it says about itself), `createdAt`, `expiresAt`. MCP side: `dsh_approvals_pending` /
`dsh_approvals_resolve`.

  Semantics: **no answer is a refusal** (`deadlineMs` expiry counts as refused, never auto-allowed); `allow-once`
  works by temporarily switching that session's permission preset — the Host has no "allow once" API and the preset is
  the only lever the bridge has, so it **widens only while the approved call runs**, restoring immediately on
  `tools/post-execute`, with a 5-minute fallback timer in case a tool never reports; the allowance is per session,
  **at most 3 per session**, and only one escalated call per session may run at a time (same-tick concurrent requests
  produce a single pending record), after which escalation is refused. Only `workspace-write` and
  `danger-full-access` may be requested; anything else is refused without asking. Allows and refusals are counted in
  `/status` as `calls.approvals.allowed` / `calls.approvals.denied`. A held call that gets cancelled withdraws its
  request immediately (treated as a refusal), leaving no entry that could be approved later.

**Across restarts**: the per-session grant count, the sessions this bridge created, and any widening it still owes a
restore are written to `$DSH_HOME/dsh-rpc/approvals.json` (0600, atomic replace). A restart therefore neither refills
the allowance nor silences the gate for sessions the bridge made earlier, and a widening left behind by a killed
process is put back on the next start (a restore the Host refuses is logged and dropped, never retried forever).
Nothing is written while `approvals.mode` is `off`.

> **Why not `ctx.on("approval/request")`**: the approval service dispatches through
> `scopeTarget(req.agent, req.agent)`, so it only reaches answerers in that agent's own composition. Measured:
> registering listeners on both the plugin context and the root context, a real escalation **never called either**
> (the GUI panel stayed waiting), while `tools/pre-execute` is a global waterfall that covers every agent.

**Known edges**: only in-place escalation (`sandbox_permissions`) is intercepted (nothing else on the current tool
surface needs approval); `allow-once` is a session-level widening rather than "exactly once", so the counter is a
guardrail, not an exact count — and the three-per-session budget is persisted per session (a restart keeps it) while a
new session still gets a fresh three.

The `DSH_RPC_TOKEN` environment variable overrides the token (higher priority than the file), which suits CI or setups
that must not write it to disk.

---

## 6. Install and update

**From npm (recommended).** This is a standard DSH bundle; installing from the registry and from a local directory go
through the same pnpm path:

```bash
dsh plugin add @punchact/dsh-rpc-agent
```

or, from inside DSH:

```js
plugin_manager({ action: "install_bundle", target: "@punchact/dsh-rpc-agent" })
```

For a non-default profile add `--profile <name>` (`desktop` on the desktop app). To pin a version, spell it out:
`dsh plugin add @punchact/dsh-rpc-agent@0.7.6`; otherwise `latest` is used.

Three things that bite on the npm route:

1. **What gets installed is a copy, not a link.** Editing your local working tree afterwards **does not** affect the
   running plugin — that is the local-directory route's behaviour. Use the route below if you want live edits.
2. **A very fresh release can be held back by pnpm's cooldown.** Measured: installing a registry spec on release day
   fails while `minimumReleaseAge` is unsatisfied. Either pick a version past its window, or allow it explicitly in
   the profile's `pnpm-workspace.yaml` — pnpm sometimes appends this line itself; the shape is:
   ```yaml
   minimumReleaseAgeExclude:
     - '@punchact/dsh-rpc-agent@0.4.1 || 0.4.4 || 0.5.3 || 0.7.6'
   ```
3. **To check which copy is running**: use `cordis_inspect_query` (`Config.listConfigs`, `input:
   {"entry":"include:dsh-rpc-bridge"}`) and read `packageDir` — `<profile>\node_modules\@punchact\dsh-rpc-agent` means
   npm, your working tree means the link route. **The version number is not evidence**: it reads the `package.json`
   inside whichever copy, so compare `index.mjs`'s inode against the working tree as well.

Version history is in [Releases](https://github.com/Punchact/dsh-rpc-agent/releases); **every version since 0.4.4 has
been published by OIDC with SLSA provenance** (`/-/npm/v1/attestations/@punchact%2Fdsh-rpc-agent@<version>` returns
200). Note that `0.4.1` / `0.4.2` were unpublished and are no longer on the registry — they were failed versions from
the early release pipeline.

**From a local directory (you are editing the source)**:

```js
// Let DSH install it (activated immediately); target is the absolute path to this directory
plugin_manager({ action: "install_bundle",
                 target: "<absolute-path-to-your-clone>" })
```

- This install is a **link to the directory**, so source edits need no reinstall.
- But the Host will not re-`import` on file changes; to load new `lib/*.mjs`, toggle the plugin row off and on:

```js
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: false })
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: true  })
```

`bin/` and `test/` are separate processes; they need no reload.

**Releasing (maintainers only)**: see [docs/release.md](./docs/release.md).

---

## 7. Security model

**One sentence: this plugin's bearer token is permission to make DSH act on this machine on your behalf.**

A process holding the token can create sessions and deliver prompts, and DSH will then use **its own** tools to read
files, write files, run commands and reach the network — governed by DSH's sandbox and approval policy, not by this
plugin. The plugin does two things only: forward the request to the Host and the result back. It widens no permission
and reviews no content.

| Surface | Current state | Notes |
| --- | --- | --- |
| Transport | loopback + Bearer token | `127.0.0.1` / `::1` / `::ffff:127.0.0.1` only; anything else is 403 |
| Token storage | `%USERPROFILE%\.dsh\dsh-rpc\token` | 32 random bytes on first start, mode 0600 (best effort off POSIX) |
| Token comparison | SHA-256 + timing-safe compare | Never returns early on a byte mismatch |
| Unauthenticated endpoint | `GET /health` | Only `{ok, plugin, version, protocol, authenticated}` — no sessions, configuration or paths |
| Body limit | 1 MiB (configurable) | Over the limit returns 413 rather than reading forever |
| Origin check | Socket `remoteAddress` | `X-Forwarded-For` is ignored; behind a reverse proxy you will always see the proxy |

**Deliberately absent**: transport encryption (loopback only, no external listener), rate limiting, request signing,
and prompt logging by default (`logRequests` explicitly enables header logging).

**Exposing it to a LAN**: `allowRemote: true` only removes the loopback allow-list and **adds no authentication
strength**. Such a deployment belongs behind a TLS-terminating proxy with its own access control; beyond a single-user
machine it is not recommended.

**Shared machines**: the token file is the credential. Do not paste it into shell history, plaintext CI variables or
chat logs; if you suspect a leak, delete the file and reload the plugin — a new token is generated and the old one
stops working immediately.

---

## 8. Ports and connection stability

DSH's web server port is chosen by the launcher (the desktop app delegates to the OS), so **it changes after a
restart**. This plugin does not pin it.

**Why not hardcode it in the patch**: `dsh-web-app`'s webserver row uses `!!js` to read `ctx.webStartup.port ?? 3080`,
and a `cordis.patch.yml` override **replaces the whole config row** — pinning it would mean restating `host` / `tls` /
`compression` and silently losing any key a future release adds. A taken port also stops DSH from starting, and
multiple instances become impossible. Following DSH is the more robust choice.

**The endpoint is published by the plugin**: on every activation it calls `ctx.webServer.getOrigin()` and writes the
real address to `endpoint.json`; clients (CLI / MCP / `lib/client.mjs`) **re-read it on every call** and cache
nothing.

**Inside a restart window only one error is retried**: the client retries once (re-reading the endpoint) for
`ECONNREFUSED` — TCP was refused, the request never left. `ECONNRESET` / `EPIPE` / timeouts are **not** retried,
because the bytes may already have been accepted and a resend risks delivering the prompt twice. An explicit `--url`
or `DSH_RPC_URL` is never retried either — you named the address, so that error is the answer.

**Chaining scripts across a restart**:

```powershell
node bin/dsh-rpc.mjs health --wait 15000; if ($?) { node bin/dsh-rpc.mjs ask "接着干" --session session-xxxx }
```

`--wait` re-reads the endpoint every 250 ms and probes; it returns 0 when ready (printing the elapsed time) and 3 on
timeout.

**Still-failing cases**: the Harness is starting and the plugin is not yet active (`endpoint.json` still holds the old
address — `pid` unchanged, port already dead), or several instances are running (single file, last writer wins). Use
`--url` explicitly for those.

**After the caller disconnects**: a non-streaming request aborts that call when the socket closes — the event iterator
stops and the run slot is released, but **the turn is not cancelled**; it keeps running in the Host and can still be
collected with `wait` (and seen in the GUI). That is the difference between abort and cancel; the bridge only does the
former.

**How an aborted call is accounted**: it lands in `/status`'s `calls.outcomes`, not in `errors` — `timeouts` means "the
budget ran out", `cancelledByClient` means "the caller left". Both are accepted calls with different endings.

---

## 9. Following a CLI task in the GUI

The CLI's stdout belongs to the terminal that ran it — that is the **caller's** output. But the turn it drives **is a
real session inside the Harness**, so it also appears in the GUI:

| Layer | Where you see it |
| --- | --- |
| The CLI process's stdout / stderr / exit code | Only in the terminal that ran it |
| The session and its full transcript | The GUI sidebar; open it for the transcript, tool calls and token usage |

That works because the plugin goes through the Host's `sessionController` (not a bare agent): session logs, title
generation and `running` state all come from the same store.

**Three practical points**:

1. **Always pass `--cwd`.** Without it the Host uses the process working directory (usually DSH's own profile
   directory), and such a session is hard to identify in the sidebar.
2. **Keep the returned `sessionId`.** `wait` / `history` / continuing / taking over in the GUI all need it.
3. **The GUI does not pop up anything.** The session simply appears in the list; you have to open it.

**Approvals still belong to the GUI or your policy**: if the turn triggers a tool call that needs human approval it
hangs on the Host side; with nobody opening that session it waits until `timeoutMs` runs out — `ask` then returns
`status:"timeout"` and **does not** cancel the turn (continue in the GUI, or call `dsh.sessions.cancel`).

---

## 10. The status panel in Settings

Once installed, the settings window grows an **"RPC bridge"** entry (`Settings → RPC bridge`). It answers "is the
bridge alive, and who called what just now":

| Block | Contents |
| --- | --- |
| Status light | Online / unreachable, version, last refresh time (the page polls every 2 s) |
| Runtime info | Endpoint URL, protocol version, credential source (`config`/`env`/`file`/`generated`), uptime, `pid`, Node version, whether remote is allowed, total and failed calls |
| Running turns | Each active `ask`/`wait`: first 8 chars of the run id, whether it has a session, whether it carries a prompt, how long it has run |
| Last 12 calls | Time, method, duration, success/failure and error code |
| Method usage | Per-method counts and error counts, plus the two non-failure outcomes `timeouts` / `cancelledByClient` |
| How to connect | Two copy-paste commands (register the MCP server, try the CLI) |
| Config snippet | A `cordis.patch.yml` row generated from the effective values, one click to copy — configuration belongs in the profile's patch layer, the page only writes down what to paste |

It reads **`GET /dsh-rpc/status`**, which shares `/health`'s trust boundary — **loopback only, no token**, because a
browser page cannot read the token from `endpoint.json`. In exchange the endpoint must say nothing:

- no token, no `sessionId` (active turns expose only the first 8 chars of the run id and whether a session exists);
- no call arguments at all — no prompt text, no tool arguments (see the comments in `lib/stats.mjs`). Accounting keeps
  only the **method name, duration and result code**.

Everything on the page comes from that read-only endpoint; it writes nothing. To make the panel disappear, disable the
plugin — `/status` goes down with it.

> The port does not matter: the page requests the fixed path `/dsh-rpc/status` (the plugin keeps this alias when
> `path` is changed), and the `origin` in the data is always the real listening address.

---

## 11. Verify

```powershell
cd dsh-rpc-plugin
npm test                       # runs the ten suites below (182 cases), no Harness, no npm install needed

node test/methods.test.mjs      #  76 cases: turn attribution, steer, timeout, abort reasons, history, cancel, argument contracts…
node test/mcp-format.test.mjs   #  19 cases: result rendering (note / next / truncation / dedupe / pending approval)
node test/registry.test.mjs     #   8 cases: sticky-session table, corrupt-file fallback, rotation
node test/pending.test.mjs      #  36 cases: pending store, long poll, cancellation withdrawal, allowance reservation, transaction edges
node test/approvals.test.mjs    #  11 cases: config validation, the gate's deny/delegate branches, ownership, allow-list
node test/approval-state.test.mjs # 8 cases: the ledger across restarts, field merging, TTL, orphan recovery
node test/wait.test.mjs         #   6 cases: sliced waiting (real HTTP stub)
node test/abort.test.mjs        #   7 cases: the abort chain (real socket / in-process registry)
node test/client.test.mjs       #   6 cases: client retry and error reporting
node test/status.test.mjs       #   6 cases: /status payload and route-mount contract
node test/catalog.smoke.mjs     # method catalogue and the four package-name checks

npm ci && node test/host.test.mjs    # 1 case: real-Host integration (real WebServer, needs devDependencies)
node test/e2e.mjs --cwd .            # 14 cases: end-to-end against a live Harness
node test/edge.mjs                   # 24 cases: protocol/boundary adversarial checks against a live Harness
```

`npm test` runs the first ten suites in a fixed order (182 cases; none need a Harness or `npm install`);
`npm run test:host` runs the real-Host integration; `npm run test:e2e` / `npm run test:edge` need a live Harness.
**Do not use `node --test`**: it forks a child process per file, which the DSH sandbox blocks with `spawn EPERM`.

- **Unit** uses `node:test` with a hand-written Host double (event stream, event bus, `user/message` claiming) to cover
  turn attribution, steer, timeouts, abort reasons, history, cancel, concurrent refusal and `queue`, the creation-time
  argument contract (including refusing a caller-supplied `sessionId`), `cwd` ownership, workspace / model / permission
  delivery, `limit` validation and dispatcher error codes. Last run: 76/76 (2026-11-06).
- **Rendering / sliced waiting / abort / sticky sessions** each have their own suite: rendering pins every ending's
  `note:` and `next:`, long-body truncation and field dedupe; waiting uses a real HTTP stub to verify "the budget is
  sliced and no slice overruns"; abort uses a real socket to verify "a caller hanging up aborts this call" and pins
  "an aborted call is not an error"; the registry suite covers sticky-table reads/writes, corruption fallback and
  rotation. Last run: 19/19, 6/6, 7/7, 8/8 (2026-11-06).
- **Approvals and the ledger** have their own suites: `approvals` pins configuration validation and the gate's
  `deny`/`delegate` branches (including "never claim a session you cannot attribute"), `pending` pins the pending store
  and its transaction edges (a throwing downstream must restore the preset, same-tick concurrency asks once,
  cancellation withdraws the request), `approval-state` pins the ledger across restarts and field merging. Together with
  mutation testing they guard the approval chain. Last run: 11/11, 36/36, 8/8 (2026-11-06).
- **Client** uses a temporary `$DSH_HOME` and a local fake server to verify retry and error policy: retry once after
  the endpoint is rewritten and deliver exactly once, never replay `ECONNRESET`, never retry an explicit `--url`, do
  not rewrite a post-retry failure into "nothing is listening", and include `pid` plus the next step in the error when
  the endpoint did not change; another case pins how `lib/transport.mjs` digs the real errno out of undici's cause
  chain per platform (on Linux `UND_ERR_SOCKET` normalises to `ECONNRESET`). Last run: 6/6 (2026-11-06).
- **The status page** uses a fake `webServer` and fake `res` to pin three things: the `/status` payload is aggregate
  only (asserting no token, no `sessionId`, no prompt text), non-loopback is always 403 and non-GET/HEAD is 405, and the
  **route-mount contract** (a second generation in the same process can take over the previous route without hitting
  `duplicate exact route`; a failed mount rolls the whole thing back; only the current owner can really unregister).
  Last run: 6/6 (2026-11-06).
- **Real-Host integration** uses no fake `webServer`: `new Context()` plus `ctx.plugin(WebServer, {host:'127.0.0.1',
  port: 0})` for a real listener, then `apply()`, then real HTTP asserting `/health` 200, unauthenticated RPC 401,
  `/status`'s `origin` equal to the real listener, 404 inside the prefix, and **finally running the plugin's own disposer
  and asserting `/health` and `/status` both become 404**. This is the one test that catches "a previous generation's
  route leaked and broke the reload". Last run: 1/1 (2026-11-06).
- **End-to-end** goes through the same `lib/client.mjs` an external agent would, so green proves the whole chain plugin
  → Host `sessionController` → HTTP → JSON-RPC → caller. Last run: 14/14 (2026-11-05).
- **Boundary** checks the protocol layer: batch, notifications, id shapes, auth headers, oversized bodies (a real 413,
  not a disconnect), argument-injection guards, timeout clamping, concurrent asks, `limit` semantics. Last run: 24/24
  (2026-11-05).
- **Port drift** (manual): point `endpoint.json`'s url at a dead port and run `dsh-rpc ping`; it must exit 3 with a
  readable message containing `nothing is listening`, `pid` and `health --wait`. Restore the file and `ping` works
  immediately. Verified 2026-11-05.
- **Display check**: the plugin row's title and icon were confirmed visually in the Plugins page (`RPC Bridge` plus this
  package's icon, 2026-11-05). Note that `plugin_manager list_bundles` prints `package.json`'s `description`, which is
  not the same source the UI uses — do not cite it as proof that a locale took effect.

---

## 12. Known edges

- **One "asking" run per session**: two concurrent `ask` calls from this plugin make the second return `-32004` by
  default; with `queue: true` it waits for the first to finish (within its own `timeoutMs`, `-32005` otherwise). While
  queued, `ping` and the status page show `state: "queued"`. This constrains this plugin only — the GUI or another agent
  can still speak in the same session; attribution uses the `rpcId` in `user/message` (§3), so their answer is never
  reported as yours, at the cost of waiting for their turn to finish. `wait` is unrestricted.
- **`wait` only sees the snapshot window**: `wait` decides "current/last turn" from the first `follow` frame, capped at
  500 events (`maxMessages`). In a very long session a truncated snapshot may miss the target turn and report
  `completed` when that turn really ended `aborted`/`blocked`; call `history` with the `sessionId` to confirm.
- **Batches run serially**: multiple JSON-RPC requests in one HTTP batch execute **in order**, not concurrently, so one
  slow `ask` blocks the rest. Use separate connections for concurrency.
- **Approval policy is not duplicated**: the Harness still applies its own approval and sandbox policy; a tool that
  needs human approval can hang that turn for a long time (bounded by `timeoutMs`). A `permissionPreset` only sets the
  session's default preset — it is not an approval.
- **Location is decided at creation only**: `workspaceId` / `cwd` do nothing on an existing session and the bridge
  rejects them instead of ignoring them. Changing location means a new session (the old one stays).
- **Changing the model changes the profile default**: `selectModel` is the Host's model-switch entry point and stores
  the choice as the profile default (same as switching in the GUI). After an external agent switches, new GUI sessions
  use that model too.
- **Permission presets need an optional service**: without the `permissionPresets` service, passing `permissionPreset`
  returns `-32000` explaining why, rather than silently skipping.
- **Workspaces are add-only**: the bridge exposes `workspaces.list` / `workspaces.create` only; delete and rename in the
  GUI so an external agent cannot remove your sidebar entries by accident.
- **Only Host-permitted sessions are forwarded**: `sessions.list` and `history` pass through the Host's `remoteAccess`
  filter — you see what this process is allowed to see.
- **Body truncation**: a single turn keeps at most 4000 events; `text` stays complete (it comes from
  `assistant/message`), but `tools` may be truncated in very long sessions.
- **Token exposure**: the token lives in `%USERPROFILE%\.dsh\dsh-rpc\token`, alongside DSH's other credentials; mind
  the ACL on shared machines. **Sessions this bridge creates can read it**: a sub-agent runs as the same OS user, and
  `workspace-write` permits reading the user directory (measured 2026-11-06: a sub-session read the token and called
  `dsh.ping` over `POST /dsh-rpc`). So `approvals.delegate` defends against **mistakes and prompt injection**, not
  against "another process of the same user on the same machine decides to escalate".
- **The gate covers one path only**: `approvals.mode`'s `deny` / `delegate` intercept **`sandbox_permissions` in tool
  arguments**. Changing a session's preset via `dsh.sessions.configure`, or choosing a preset when creating a session,
  is a different path — when `approvals.mode` is not `off` the former is refused and a session may no longer be moved to
  `danger-full-access`, but a preset chosen by the caller **at creation** is not gated (that is the dispatcher's
  decision, not the sub-agent's).
- **No `Config` schema**: the plugin validates the `config` row by hand instead of exporting `Config` (to stay
  dependency-free and avoid peer resolution in the profile). The cost is that `cordis_inspect_query` shows
  `status: absent` for this row and there is no visual form; keys and defaults are in §5.

---

## 13. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `dsh-rpc: 401` | Token mismatch. Delete `%USERPROFILE%\.dsh\dsh-rpc\token` and reload the plugin to regenerate |
| `403` | Origin is not loopback; check for a proxy, or enable `allowRemote` |
| `-32004 … already has a bridge run waiting for its turn` | Another `ask`/`prompt` is already waiting on that session; use a different one or wait (you can still `wait` in parallel) |
| `3 · cannot connect` | The Harness is not running, or the plugin row is disabled; probe with `node bin/dsh-rpc.mjs health` |
| Edited the source but behaviour did not change | The Host cached the module: toggle the plugin row off and on |
| Same, but installed from npm | The npm route installs a copy unrelated to your working tree; use the local-directory route in §6 to iterate |
| Install fails on the cooldown / version not found | The fresh release may still be inside `minimumReleaseAge`; pin a version past its window, or allow it in the profile's `pnpm-workspace.yaml` as in §6 |
| `Cannot read properties of undefined (reading 'throwIfAborted')` | Older versions called the Host's `prompt`/`list` with `undefined`; fixed (the Host requires a `signal` there) |
| Plugin row shows `absent` | Expected: the plugin exports no `Config` schema, so `cordis_inspect_query` has no config contract for it |

---

MIT licensed — see [LICENSE](./LICENSE).
