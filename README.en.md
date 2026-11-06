# dsh-rpc-agent

[中文](./README.md) · Unofficial project

> The repository and the package are both `dsh-rpc-agent`. The CLI names (`dsh-rpc`, `dsh-rpc-mcp`), the endpoint path (`/dsh-rpc`), the state directory (`~/.dsh/dsh-rpc`) and the `DSH_RPC_*` environment variables stay as they are: they are runtime contracts, and changing them would invalidate installed configs and paired tokens together.

A loopback **JSON-RPC bridge** that lets any local agent — Claude Code, Cursor, Codex CLI, Trae, or your own script — hand a task to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and get its final answer back.

The Harness is not just a model here: it is a **full agent** with its own tools, skills, MCP servers, sandbox and session context. The caller needs one HTTP request or one MCP tool.

> **Not affiliated with DeepSeek.** This is a third-party plugin, independently maintained, not endorsed or supported by DeepSeek. Read [Security model](#security-model) first: holding this bridge's token means holding permission to make the Harness act on this machine.

```
Claude Code / Cursor / Codex ──┐
dsh-rpc CLI ───────────────────┼──► http://127.0.0.1:<port>/dsh-rpc ──► DSH agent
your script (import lib/client)┘        JSON-RPC 2.0 + Bearer token
```

The port is **not fixed**: the Harness asks the OS for one on every start, so it changes across restarts. `node bin/dsh-rpc.mjs ping` prints the current `origin`; the plugin also publishes it to `endpoint.json`, which every client re-reads per call.

## Install

**From npm (recommended).** This is a standard DSH bundle: the registry route and the local-directory
route go through the same pnpm path.

```bash
dsh plugin add @punchact/dsh-rpc-agent
```

Or ask the Harness directly:

```js
plugin_manager({ action: "install_bundle", target: "@punchact/dsh-rpc-agent" })
```

Add `--profile <name>` for a non-default profile (the desktop app is `desktop`). To pin a version, spell it out:
`dsh plugin add @punchact/dsh-rpc-agent@0.4.4`; without one you get `latest`.

Three things that bite on the npm route:

1. **The install is a copy, not a link.** Editing your local clone afterwards does **not** change the running
   plugin — that is the clone route's behaviour. Use the clone route while you iterate.
2. **A fresh release may be held back by pnpm's release age.** Measured: installing 0.4.4 from a registry spec
   on its release day failed because `minimumReleaseAge` had not elapsed. Either pin a version that has aged
   past the window, or allow it explicitly in the profile's `pnpm-workspace.yaml`:
   ```yaml
   minimumReleaseAgeExclude:
     - '@punchact/dsh-rpc-agent@0.1 || 0.4.4'
   ```
3. **To tell which copy is live**, ask `cordis_inspect_query` (`Config.listConfigs`,
   `input: {"entry":"include:dsh-rpc-bridge"}`) for `packageDir`: `<profile>\node_modules\@punchact\dsh-rpc-agent`
   means the npm route, your own checkout means the link route. The reported version is **not** evidence on its
   own — it is read from whichever `package.json` is loaded.

Release history: [Releases](https://github.com/Punchact/dsh-rpc-agent/releases). Since 0.4.4 every release is
published over OIDC and carries SLSA provenance.

**From a local clone (while you edit the source).**

```js
// Let the Harness install it; `target` is the absolute path of your clone.
plugin_manager({ action: "install_bundle", target: "<absolute-path-to-your-clone>" })
```

The install is a **link** to the clone, so source edits need no reinstall — but the host caches ES modules. To load new `lib/*.mjs`, toggle the plugin row once:

```js
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: false })
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: true  })
```

`bin/` and `test/` run as separate processes and never need a reload.

Requires Node `^22.19.0 || >=24`. Zero runtime dependencies.

Maintainers: see [docs/release.md](./docs/release.md).

## Use it

### MCP (recommended)

`bin/` means the **package's** own `bin/` directory. With the npm route (recommended, default desktop profile) it is:

```powershell
claude mcp add dsh -- node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\bin\dsh-rpc-mcp.mjs"
```

Cursor / Codex use the equivalent config file, with `args` set to that same path:

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

On the clone route, substitute `<path-to-your-clone>\bin\dsh-rpc-mcp.mjs`. The CLI examples below are written as
`node bin/...`, i.e. "run it from inside the package".

Seven tools: `dsh_ask`, `dsh_workspaces`, `dsh_permissions`, `dsh_sessions`, `dsh_wait`, `dsh_cancel`, `dsh_status`. Arguments are snake_case (`prompt`, `project`, `reuse`, `mode`, `wait`, `session_id`, `cwd`, `workspace_id`, `agent_preset`, `model`, `reasoning_effort`, `permission`, `timeout_ms`). Every `dsh_ask` result starts with `session <id>` on its own line; the body and an `— outcome: …` meta line follow. The MCP server shares no context with the Harness session — either pass that id back, or pass the same `project` and let the sticky table reuse the session (below).

### CLI

```powershell
node bin/dsh-rpc.mjs health --wait 15000     # unauthenticated liveness, poll until ready
node bin/dsh-rpc.mjs ping                    # authenticated status
node bin/dsh-rpc.mjs workspaces              # workspaces shown in the DSH sidebar
node bin/dsh-rpc.mjs permissions             # permission presets (* marks the default)
node bin/dsh-rpc.mjs ask "summarize this repo" --cwd . --json
node bin/dsh-rpc.mjs ask "look at this one" --workspace ws-xxxx --json
node bin/dsh-rpc.mjs ask "continue" --session session-xxxx --json
node bin/dsh-rpc.mjs ask "think again" --session session-xxxx --model anthropic/opus-4.6 --effort high
node bin/dsh-rpc.mjs sessions --limit 10
```

Exit codes: `0` done · `1` failed or the turn did not complete · `2` usage error · `3` cannot reach the Harness.

### HTTP

```powershell
$endpoint = (Get-Content "$env:USERPROFILE\.dsh\dsh-rpc\endpoint.json" -Raw | ConvertFrom-Json).url
$token    = (Get-Content "$env:USERPROFILE\.dsh\dsh-rpc\token" -Raw).Trim()
$body = @{ jsonrpc = "2.0"; id = 1; method = "dsh.sessions.ask";
           params = @{ text = "hello"; cwd = "C:\path\to\work" } } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri $endpoint `
  -Headers @{ Authorization = "Bearer $token" } -ContentType application/json -Body $body
```

### JavaScript

```js
import { rpcCall } from "@punchact/dsh-rpc-agent/http-client";

const answer = await rpcCall("dsh.sessions.ask", { text: "summarize this repo", cwd: process.cwd() });
console.log(answer.text, answer.usage);
```

`rpcCall` resolves to the method's `result`; failures throw an `Error` carrying `code` / `data` / `status`.

### Sticky sessions (0.5.0)

When `dsh_ask` has no `session_id`, it no longer blindly creates a session. It looks up `${client name}::${project ?? cwd}` in `~/.dsh/dsh-rpc/sessions.json`; if the entry names a session that still exists and is not blank, that session is reused — otherwise a new one is created and written back. Two calls with the same `project` therefore land in one conversation, which is how "one project, one session" actually happens.

| Argument | Values | Meaning |
| --- | --- | --- |
| `project` | any stable label (repo, ticket) | the sticky key; omitted, the session `cwd` is used |
| `reuse` | `auto` (default) / `never` / `latest` | `auto` uses the recorded session; `never` always creates; `latest` ignores the recorded id and picks the most recently updated session for that key |

Two boundaries: **different MCP clients do not inherit each other's sessions** (`clientInfo.name` is part of the namespace), and nothing is guessed — a recorded session that was deleted or is still blank is simply replaced, never reported as an error. The table lives in the bridge, is written atomically with mode 0600, and a corrupted file degrades to "no records" rather than failing a call.

A single session eventually becomes a context burden, so after **200 `ask` calls** on one key it rotates: a new session is created and the old id comes back as `previousSessionId` with `rotated: true`. That count is of prompts this bridge delivered, not of all messages the Host ever held — the Host has no cheap message counter.

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `dsh.discover` | — | version, running config (`defaultTimeoutMs`, `maxWaitSliceMs`, plus `maxWaitSliceMsRequested` when clamped), transport address, method catalog |
| `dsh.ping` | — | `{ok, plugin, version, protocol, origin, tokenSource, activeRuns}` |
| `dsh.models` | — | routable providers and models |
| `dsh.workspaces.list` | — | `{total, items:[{id, title, path, status, sessions, …}]}`, `status` ∈ `ok` / `missing-dir` / `unknown` |
| `dsh.workspaces.create` | `path, title?` | `{id, title, path}`: register a directory as a workspace (idempotent per path) |
| `dsh.permissions.catalog` | — | `{options:[…], defaultPreset}`: each preset is a sandbox mode plus an approval policy |
| `dsh.sessions.configure` | `sessionId, model?, reasoningEffort?, permissionPreset?` | `{sessionId, selected?, permissionPreset?}` |
| `dsh.sessions.list` | `limit?, cwd?, sort?` | `{total, sort, cwd, items[]}`: `cwd` filters by path prefix, `sort` is `updatedAt` (default) or `createdAt`, newest first. **The Host's `list()` only carries `updatedAt`** (measured on this machine), so `createdAt` is `null` and sorting by it keeps the Host's order |
| `dsh.sessions.create` | `workspaceId? \| cwd?, agentPreset?, model?, reasoningEffort?, permissionPreset?` | `{sessionId, agentPreset, cwd, selected?, permissionPreset?}`. **No `sessionId`** — ids belong to the Host; passing one is refused with `-32602` rather than silently replaced |
| `dsh.sessions.ask` | `text, sessionId?, project?, reuse?, namespace?, workspaceId? \| cwd?, agentPreset?, model?, reasoningEffort?, permissionPreset?, mode?, queue?, timeoutMs?, wait?` | turn result (below). `sessionId` omitted means the sticky table (`namespace::project ?? cwd`) decides between reuse and a new session; the result carries `created` / `reused` / `rotated`. **The RPC `wait` still defaults to `true`** (only the MCP tool defaults to `false`). A second prompting run on the same session is refused with `-32004` unless `queue: true`, which waits for that session inside its own `timeoutMs` |
| `dsh.sessions.prompt` | `sessionId, text, mode?, model?, reasoningEffort?, permissionPreset?` | `{accepted, sessionId, requestId, mode, selected?, permissionPreset?}`, returns immediately. Does **not** reserve the session, so a concurrent `ask` can still claim that turn — pair it with `dsh.sessions.wait` when the answer matters. Session settings such as `model` take effect here, which is what the CLI's `prompt --model` relies on |
| `dsh.sessions.wait` | `sessionId, timeoutMs?, since?` | turn result; `since` returns only the events after that cursor |
| `dsh.sessions.cancel` | `sessionId` | `{accepted}` |
| `dsh.sessions.history` | `sessionId, limit?` | `{cursor, turn, running, messageCount, records[]}` |

**Where a session lives, and what it runs with.** These are the Host's own concepts; the bridge only forwards them.

- `workspaceId` goes through `workspace.attachSession`, so the session shows up under that workspace in the GUI sidebar. `cwd` only sets the directory. They are mutually exclusive, and both apply **only when the session is created** — relocating an existing session is refused rather than silently ignored. `agentPreset` is creation-only for the same reason.
- Neither the CLI nor the MCP bridge pre-filters those options: whatever you pass is forwarded, and the bridge gives one shared refusal. A dropped flag must never look like an honoured one.
- `model` / `reasoningEffort` reach the Host's `selectModel`. A bare model id is resolved against the catalog: one match is used, several are reported with the spellings that disambiguate, none points you at `dsh.models`. `reasoningEffort` needs `model` in the same request, because the Host exposes no "read the current model back".
- `permissionPreset` goes through the Host's `permissionPresets` service and is validated against its catalog first. Each catalog entry carries a `cost` sentence, because the deployment's own `description` is often empty.
- **Leave it unset by default; escalate once when the sandbox actually blocks you.** A blocked turn comes back with `sandbox.denied: true` and a `next` pointer: retry in the *same* session with `permission: "danger-full-access"`, once. That preset is full access with approvals disabled (`never`), so nothing else restricts that turn — it is the last resort, not a wider default, and the caller should say it used it.
- Why escalation has to happen outside the session: the Host's sandbox suggests retrying with `sandbox_permissions`, but a bridge-driven session is unattended. With `approval: ask` there is no answerer, so the request collapses to `unavailable` (which does not grant anything); with `approval: never` the system prompt forbids requesting escalation at all. Both paths are closed, so the caller must switch presets and ask again.
- The sandbox ladder is a closed table: `read-only` may rise to `workspace-write` or `danger-full-access`, while **`workspace-write` may only rise to `danger-full-access`** — there is no middle step.
- ⚠️ A model switch **also becomes the profile default** (the Host does this for GUI switches too), so an external agent that changes the model changes what your next GUI session starts with.


A **turn result** carries `sessionId`, `turn`, `status` (`completed` / `aborted` / `blocked` / `error` / `max-tokens` / `interrupted` / `forked` / `idle` / `timeout` / `unknown`), `reason`, `text`, optional `reasoning`, `tools[]` (`{callId, name, arguments, output?, isError?}`), `usage`, `durationMs`, `timedOut`, `partial`, `requestId`, `created`, `cursor` — plus, when the sandbox refused an action, `sandbox: {denied: true, marker, source}` and `next: {tool, reason, args}`.

`sandbox.denied` is set **only** when the Host's fixed marker (`[sandbox: file access denied`) appears in a tool output or, failing that, in the turn's text. It is never inferred from words like "denied" in the answer: a missed report beats a false one. `source` says which of the two matched — `tool` is the reliable one; `text` means only the agent's own reply carried the marker, and an agent writing *about* sandbox refusals can quote it. Neither `sandbox` nor `next` is an error — the turn did run, `status` and the tool-error flags are unaffected. Tool `output` is truncated per tool and the whole turn shares one 20 000-character budget, so a chatty turn cannot flood the caller's context.

`status` always comes from that turn's own `turn/end` reason. A `turn/end` with **no `reason`** is reported as `unknown` with `reason: {kind:"unknown", message:"the Host ended the turn without a reason; treat this outcome as unverified"}`: the field is required by a TypeScript union, and a union is not a runtime guard — an ending nobody described must not be reported as success. `partial: true` means the event stream ended before `turn/end`, so `text` is a fragment. A `timeout` does **not** cancel the turn; since there is no `turn/end` to quote, the bridge fills `reason` with `{kind:"timeout", message:"… it keeps running"}` rather than leaving it null.

**Not waiting (the MCP tool's default)** — `dsh_ask` returns a handle instead of a turn result; pass `wait: true` to block: `{sessionId, requestId, mode, status:"running", turn:null, text:"", accepted:true}`. The turn keeps running in the Harness and `dsh_wait` collects it. Use it when your own tool timeout is shorter than the work. The handle deliberately does **not** occupy the bridge's turn slot, so there is a millisecond-wide window before `dsh_wait` takes over; a second `ask` in that window is refused with `-32004` rather than silently queued.

**Mutually exclusive** — `queue: true` asks to wait for the turn slot, `wait: false` never waits; combining them is refused with `-32602` instead of silently dropping one.

**Deltas** — `wait` accepts `since`: with it, only events after that sequence are returned (so `text` is just that slice), while `status`, `turn`, `tools`, `usage` and `sandbox` still describe the whole turn — the delta narrows the prose only — and `cursor` still advances. Poll with `since: <last cursor>`; never re-send the prompt.

**Waiting is sliced** — a single HTTP request cannot outlive five minutes (Node's built-in fetch has a 300 s `headersTimeout`; the CLI failed at 303.9 s with `fetch failed`). The bridge therefore answers at `maxWaitSliceMs` (default **120000**, capped at 240000 — a larger value is clamped with a warning) with `status:"timeout"` plus `sliceMs`/`requestedMs`, and the caller asks again. The CLI and the MCP tools already loop for you — pass a total budget; a hand-written client must slice itself or keep every wait under 300 s. `waitedMs` is wall-clock: a tail slice below 1 s is raised to the 1000 ms floor, so it may exceed the budget by up to a second, while `slices` stays the true request count. **The answer belongs to our deadline, not to the Host**: every event read races this run's deadline, and the cleanup that unsubscribes from the Host stream waits at most one second — a stuck Host can delay us, but it cannot hold the answer. That is the direct fix for a `wait` that once sat 13 minutes.

**How MCP renders this** — a tool result is an error **only when the call itself failed** (with a code and a `next:` hint). The turn's `status` goes into an `outcome:` line, and **every end reason also gets a `note:` (plain-English explanation) plus a `next:` step — only `completed` gets neither**:

```
session session-a
— outcome: aborted · turn 5 · 12.3s · 3 tool calls · cursor 88
note: the turn was stopped (cause: user — the Host cannot tell a bridge cancel from someone pressing stop)
reason: {"kind":"aborted","reason":{"kind":"user"}}
next: do not resend blindly: ask the human whether to continue, then resend with the same session_id
```

`aborted` / `blocked` / `error` / `max-tokens` / `interrupted` / `forked` / `refusal` / `unknown` each get their own wording: `aborted` names who stopped it (`user` / `parent` / `hook{reason}` / `disposed` / `legacy`), `error` turns the `LlmFailure` `code` and `message` into one line saying "this is not a tool failure", and `max-tokens` warns that resending will be truncated again. **A `kind` this bridge has never seen is not an anomaly** — the Host's `TurnEndReasonMap` is merge-extensible (source comment: `a backend-added variant cannot be listed`), so such outcomes degrade to "unverified, check `dsh_sessions()` first" instead of passing as `completed`.

While the turn is still running you get the collection hint:

```
next: the turn is still running — do NOT resend the prompt. Call dsh_wait({ session_id: "…", timeout_ms: 600000, since: 31 }) to collect it.
```

A `partial` result no longer claims "still running" (it only means the stream ended without a `turn/end`; the Host may have died with it): its `next:` asks for `dsh_sessions()` first, then `dsh_wait` or a resend.

That line exists because "not finished" used to look like a failure, and a retry after that is a *new prompt* — which is how one task became four sessions. `status` cannot be used for the decision: it is the Host's free-form `reason.kind`.

**Turn attribution**: after submitting, the bridge looks for its own `user/message` (`source.rpcId` equals the request id) and takes the turn that message landed in. If something else (the GUI, another agent) speaks first in the same session, their answer is never returned as yours.

`POST /dsh-rpc/stream` takes the same params and answers NDJSON: `{type:"session"}`, `{type:"progress", frame}`, then `{type:"result", …}` or `{type:"error", error}`.

## Unattended sessions and approvals

A session this bridge created has nobody in front of the GUI. When the model asks to escalate its sandbox (`sandbox_permissions`), the Host parks that call until someone answers — and there is no one. Two measured cases: `approval/asked` was written, no `approval/decided` ever followed, and the caller timed out on its 120-second budget both times.

Set `approvals: { mode: "deny" }` and the bridge installs a `tools/pre-execute` gate that refuses **in-place escalation** from the sessions it created. A call carrying `sandbox_permissions` is denied before dispatch, and the model is told:

`approvals.mode=deny refused a sandbox escalation to "danger-full-access" for tool "pwsh"; the call was not executed.`

It only ever removes privilege: calls that do not escalate are untouched, and sessions this process did not create — including everything a human is watching — are passed straight through to their own answerer. Rejections are counted in `/status` under `calls.approvals.denied`.

> **Why not `ctx.on("approval/request")`**: the approval service dispatches through `scopeTarget(req.agent, req.agent)`, which only reaches answerers inside that agent's own composition. Measured on a live escalation: listeners registered on this plugin's context *and* on the root context were never called (the GUI panel stayed waiting), while `tools/pre-execute` is a global waterfall that reaches every agent.

The default is `off`, which leaves the Host's own fail-closed behaviour in place. Handing the decision to the dispatching agent (`delegate`) is designed in the plan document but not implemented.

## Security model

**One line: the bearer token is permission to make the Harness act on this machine.**

A process holding it can create sessions and submit prompts, and the Harness will then use **its own** tools to read files, write files, run commands and reach the network — constrained by the Harness sandbox and approval policy, not by this plugin. The bridge only forwards requests and results; it widens nothing and reviews nothing.

| Surface | Behaviour |
| --- | --- |
| Transport | loopback only by default (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`); other peers get 403 |
| Token | 32 random bytes at `%USERPROFILE%\.dsh\dsh-rpc\token`, mode 0600 where the filesystem supports it |
| Comparison | SHA-256 with a constant-time compare |
| Unauthenticated | `GET /health` returns only `{ok, plugin, version, protocol, authenticated}` |
| Request size | 1 MiB by default; larger bodies get a real 413 |
| Peer check | socket `remoteAddress` — `X-Forwarded-For` is ignored, so behind a proxy every peer looks like the proxy |

Deliberately absent: transport encryption (loopback only, never binds a public interface), rate limiting, request signing, prompt logging (unless `logRequests` is on).

`allowRemote: true` disables the loopback allow-list and adds **no** authentication strength. Treat that as a deployment decision requiring a TLS-terminating proxy and its own access control.

## Ports and connection stability

The port moves on restart, so the plugin publishes it rather than pinning it:

- Pinning would require restating the whole `webserver` row (the patch replaces the config wholesale), and a taken port would stop the Harness from starting.
- The plugin writes `endpoint.json` on every activation: `url`, `origin`, `path`, `version`, `plugin`, `pid`, `startedAt`, `updatedAt`.
- Clients re-read the file per call. They retry **once**, and only on `ECONNREFUSED` — the request never left the process. `ECONNRESET`, `EPIPE` and timeouts are reported, never resent, because a prompt may already be delivered. An explicit `--url` is never retried.

After a restart:

```powershell
node bin/dsh-rpc.mjs health --wait 15000
```

**When the caller goes away**: a non-streaming request aborts its own call when the socket closes — the event iteration stops and the run slot is released, but **the turn is not cancelled**. It keeps running in the Host and can still be collected with `wait` (and seen in the GUI). That is abort, not cancel; the bridge only does the former.

**How an aborted call is accounted**: it lands in `/status` under `calls.outcomes`, not `errors` — `timeouts` means the wait budget ran out, `cancelledByClient` means the caller left first. Both are admitted calls with a different ending.

## Follow a CLI task in the GUI

A session started from the CLI is a **real Harness session**, so it appears in the GUI sidebar — open it to see the transcript, tool calls and token usage. The CLI's own stdout stays in your terminal.

- Always pass `--cwd`; otherwise the session lands in the Harness process directory and is hard to identify.
- Keep the returned `sessionId` to `wait`, read `history`, continue, or take over in the GUI.
- The GUI does not pop up. If a turn hits an approval prompt nobody answers, it waits until `timeoutMs` and `ask` returns `status:"timeout"` **without** cancelling the turn.

## The status panel in Settings

Once installed, Settings grows a **“RPC Bridge”** page: an online/offline light, version, endpoint, credential source, uptime, `pid`, Node version, whether remote callers are allowed, the runs in flight (run id prefix, has-session, has-prompt, age), the last 12 calls (time, method, duration, outcome), per-method counters, and two non-failure outcome counters (`timeouts`, `cancelledByClient`). It refreshes every two seconds.

It reads **`GET /dsh-rpc/status`**, which sits on the same trust boundary as `/health`: **loopback only, no token**, because browser code cannot read the token in `endpoint.json`. In exchange the endpoint must stay silent about anything a caller said:

- no token, no `sessionId` (in-flight runs expose only an 8-character run id and a boolean),
- no arguments — only method name, duration and result code are recorded (`lib/stats.mjs`).

The panel is read-only and disappears with the plugin. It asks a fixed path `/dsh-rpc/status`, kept as an alias when you reconfigure `path`, and the payload always reports the live `origin`.

## Verify

```powershell
node test/methods.test.mjs     # 71 unit tests, no Harness needed
node test/mcp-format.test.mjs  # 18 result-formatting tests, no Harness needed
node test/wait.test.mjs        # 6 sliced-wait tests (real HTTP stub), no Harness needed
node test/abort.test.mjs       # 7 abort-path tests (real socket, in-process registry), no Harness needed
node test/registry.test.mjs    # 8 sticky-session registry tests, no Harness needed
node test/client.test.mjs      # 6 client retry/error tests, no Harness needed
node test/status.test.mjs      # 6 status/route-mounting tests, no Harness needed
node test/catalog.smoke.mjs    # method catalogue + the four package-name sites must agree
npm ci && node test/host.test.mjs   # 1 real-Host integration test (real WebServer; needs devDependencies)
node test/e2e.mjs --cwd .      # 14 end-to-end checks against a live Harness
node test/edge.mjs             # 24 protocol/edge checks against a live Harness
```

Run the files directly, not through `node --test`: that forks a child process, which some sandboxes forbid.

`npm test` runs all eight of the above (no Harness, no install needed); `npm run test:host` runs the real-Host one; `npm run test:e2e` / `npm run test:edge` need a live Harness.

Last run (2026-11-06): unit 71/71, result formatting 18/18, sliced waiting 6/6, abort 7/7, sticky registry 8/8, client 6/6, status 6/6, catalogue smoke ok, real-Host 1/1. End-to-end (14/14) and edge (24/24) were last run on 2026-11-05 and were not re-run for this change.

The real-Host test is the only one that cannot be fooled by a fake `webServer`: it starts an actual listener on `127.0.0.1:0`, applies the plugin, sends real HTTP, then runs the plugin's own disposers and asserts `/health` and `/status` both become 404. That is exactly the failure we shipped once — a previous generation's routes surviving a reload, so every later enable died with `duplicate exact route`.

The status tests pin the aggregate-only payload (no token, no session id, no prompt text), the 403/405 guards, and the route-mounting contract: a second generation inside one process takes over the routes a previous one left mounted instead of colliding, a failed mount rolls back completely, and only the current owner can unmount.

Port-drift check (manual): point `endpoint.json` at a dead port, run `dsh-rpc ping`, and expect exit code 3 plus a message naming `nothing is listening`, the publishing `pid`, and `health --wait`. Restore the file and `ping` recovers immediately.

## Maintenance

- [CHANGELOG.md](./CHANGELOG.md) — what changed in each release, and why.
- [SECURITY.md](./SECURITY.md) — how to report a vulnerability privately, the threat model, and what is out of scope.
- [docs/release.md](./docs/release.md) — the publishing manual (credentials, tagging, the parts that cannot be undone).
- [docs/design.md](./docs/design.md) — the decisions behind the bridge, including the ones that went wrong first.

## License

MIT © 2026 Punchact. See [LICENSE](./LICENSE).
