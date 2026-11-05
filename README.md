# dsh-rpc-agent

[English](./README.en.md) · 非官方项目

> 仓库与插件包名都是 `dsh-rpc-agent`。命令行（`dsh-rpc`、`dsh-rpc-mcp`）、端点路径（`/dsh-rpc`）、状态目录（`~/.dsh/dsh-rpc`）与 `DSH_RPC_*` 环境变量保持不变——它们是运行时契约，改了会让已装好的配置和已配对的 token 一起失效。

把 DeepSeek Harness 变成本机可调用的 **RPC 服务**：任何本地 agent（Claude Code、Codex CLI、Cursor、Trae、自己写的脚本）都能把任务交给 DSH，拿回它的最终回答。

DSH 在这里不是一个模型，而是一个**完整的 agent**——带自己的工具、技能、MCP 服务器、沙箱与会话上下文。调用方只需要一句 HTTP 或一个 MCP 工具。

> **本项目与 DeepSeek 官方无关。** 它是第三方插件，由社区开发者独立维护，不获 DeepSeek 背书，也不由其提供支持。使用前请先读第 7 节的安全模型：拿到本插件的 token，等于拿到在这台机器上驱动 DSH 执行动作的权限。

```
Claude Code / Cursor / Codex ──┐
dsh-rpc CLI ───────────────────┼──► http://127.0.0.1:<port>/dsh-rpc ──► DSH agent
自己的脚本 (import lib/client) ─┘        JSON-RPC 2.0 + Bearer token
```

端口**不是固定的**：DSH 每次启动由系统分配一个，重启后会变。`node bin/dsh-rpc.mjs ping` 输出的 `origin` 就是当前地址；插件也把它写进 `endpoint.json`，客户端每次调用现读该文件（见第 8 节）。

**目录**：[1 接入路径](#1-四条接入路径) · [2 端点与凭据](#2-端点与凭据) · [3 方法](#3-方法一览) · [4 错误码](#4-错误码) · [5 配置](#5-配置) · [6 安装与更新](#6-安装与更新) · [7 安全模型](#7-安全模型) · [8 端口与稳定性](#8-端口与连接稳定性) · [9 从 GUI 跟进](#9-从-gui-跟进-cli-发起的任务) · [10 设置页状态](#10-设置页里的状态面板) · [11 验证](#11-验证) · [12 已知边界](#12-已知边界) · [13 排障](#13-排障)

---

## 1. 四条接入路径

| 方式 | 适合 | 入口 |
| --- | --- | --- |
| **MCP 工具** | Claude Code、Cursor、Codex 等支持 MCP 的 agent | `bin/dsh-rpc-mcp.mjs` |
| **CLI** | 人在终端里试、脚本里 `$(...)` 取值 | `bin/dsh-rpc.mjs` |
| **HTTP JSON-RPC** | 任何语言的进程 | `POST http://127.0.0.1:<port>/dsh-rpc` |
| **JS 客户端库** | Node 侧集成 | `import { rpcCall, rpcStream } from "@punchact/dsh-rpc-agent/http-client"` |

### MCP（推荐）

```powershell
claude mcp add dsh -- node "<path-to-your-clone>\bin\dsh-rpc-mcp.mjs"
```

Cursor / Codex 用配置文件等价写法（Windows 下 JSON 里的反斜杠要转义；macOS/Linux 用 `/`）：

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["<path-to-your-clone>/bin/dsh-rpc-mcp.mjs"]
    }
  }
}
```

暴露 7 个工具：`dsh_ask`、`dsh_workspaces`、`dsh_permissions`、`dsh_sessions`、`dsh_wait`、`dsh_cancel`、`dsh_status`。`dsh_ask` 返回 Harness 的正文，加一行 `— session … · turn … · completed · 5.2s` 元信息。

工具参数是 snake_case（MCP 侧习惯），和 HTTP 层不同：

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `dsh_ask` | `prompt`（**必填**）、`session_id?`、`cwd?`、`workspace_id?`、`agent_preset?`、`model?`、`reasoning_effort?`、`permission?`、`timeout_ms?` | 提问一轮并等结果；`session_id` 省略即新建会话。`cwd` 与 `workspace_id` 互斥；三者都只在新建时有效，给了 `session_id` 再给会被拒绝 |
| `dsh_workspaces` | `path?`、`title?` | 不带 `path` 就列工作区；带 `path` 则登记一个新工作区 |
| `dsh_permissions` | — | 列出权限预设及其默认项 |
| `dsh_sessions` | `limit?` | 列出会话 |
| `dsh_wait` | `session_id`（必填）、`timeout_ms?` | 等该会话当前/下一轮结束 |
| `dsh_cancel` | `session_id`（必填） | 中断正在跑的轮次 |
| `dsh_status` | — | `ping` 的等价物，用于确认端点与 token 可读 |

> 参数名写错时报文很直接，例如给 `dsh_ask` 传 `text` 会得到 `` `prompt` is required ``，`isError:true`。

> MCP 服务器与被调用的 Harness 会话**不共享上下文**。给 `dsh_ask` 的 prompt 要自包含；要延续同一会话就把上次返回的 `session_id` 传回去。

### CLI

```powershell
node bin/dsh-rpc.mjs health            # 免鉴权探活
node bin/dsh-rpc.mjs health --wait 15000  # 刚重启完时轮询到就绪再返回
node bin/dsh-rpc.mjs ping              # 带 token 的真实调用
node bin/dsh-rpc.mjs workspaces        # 列出 DSH 侧栏里的工作区
node bin/dsh-rpc.mjs permissions       # 列出可用的权限预设（* 为默认）
node bin/dsh-rpc.mjs ask "只回复两个字：收到" --cwd . --json
node bin/dsh-rpc.mjs ask "看看这个工作区" --workspace ws-xxxx --json
node bin/dsh-rpc.mjs ask "接着上一句" --session session-xxxx --json
node bin/dsh-rpc.mjs ask "换 Opus 想想" --session session-xxxx --model anthropic/opus-4.6 --effort high
node bin/dsh-rpc.mjs prompt "长时间任务…" --session session-xxxx
node bin/dsh-rpc.mjs wait --session session-xxxx --timeout 600000
node bin/dsh-rpc.mjs cancel --session session-xxxx
node bin/dsh-rpc.mjs history --session session-xxxx --limit 20
node bin/dsh-rpc.mjs models            # DSH 可选模型
node bin/dsh-rpc.mjs sessions --limit 10
node bin/dsh-rpc.mjs discover          # 自描述：方法、传输、结果结构
node bin/dsh-rpc.mjs call dsh.sessions.list '{"limit":3}'
```

退出码：`0` 完成 · `1` 失败或该轮未正常结束 · `2` 用法错误 · `3` 连不上 Harness。

### 直接 HTTP

```powershell
$endpoint = (Get-Content "$env:USERPROFILE\.dsh\dsh-rpc\endpoint.json" -Raw | ConvertFrom-Json).url
$token    = (Get-Content "$env:USERPROFILE\.dsh\dsh-rpc\token" -Raw).Trim()
$body = @{ jsonrpc = "2.0"; id = 1; method = "dsh.sessions.ask";
           params = @{ text = "只回复两个字：收到"; cwd = "C:\path\to\work" } } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri $endpoint `
  -Headers @{ Authorization = "Bearer $token" } -ContentType application/json -Body $body
```

（`endpoint.json` 由插件在每次启动时重写，所以这样取地址不需要知道端口。）

### JS 客户端库

```js
import { rpcCall } from "./dsh-rpc-plugin/lib/client.mjs";

const answer = await rpcCall("dsh.sessions.ask", { text: "总结一下这个仓库", cwd: process.cwd() });
console.log(answer.text, answer.usage);
```

`rpcCall` 直接 resolve 成方法的 `result`；失败时抛出的 Error 带 `code` / `data` / `status`，可直接按错误码分支。

---

## 2. 端点与凭据

| 项 | 值 |
| --- | --- |
| RPC 端点 | `POST http://127.0.0.1:<port>/dsh-rpc`（JSON-RPC 2.0） |
| 流式端点 | `POST http://127.0.0.1:<port>/dsh-rpc/stream`（NDJSON） |
| 探活 | `GET http://127.0.0.1:<port>/dsh-rpc/health`（**免鉴权**） |
| 凭据 | `Authorization: Bearer <token>`，或 `X-DSH-RPC-Token: <token>` |
| token 文件 | `%USERPROFILE%\.dsh\dsh-rpc\token`（32 字节随机 hex，权限 0600） |
| 端点描述 | `%USERPROFILE%\.dsh\dsh-rpc\endpoint.json`（插件每次启动重写） |

`<port>` 由 DSH 自己决定，每次启动可能不同。`endpoint.json` 长这样：

```jsonc
{
  "url": "http://127.0.0.1:3820/dsh-rpc",
  "origin": "http://127.0.0.1:3820",
  "path": "/dsh-rpc",
  "version": "0.1.0",
  "plugin": "dsh-rpc",
  "pid": 12345,                              // 写这个文件的 Host 进程
  "startedAt": "2026-11-05T01:05:58.000Z",   // 该进程的启动时刻
  "updatedAt": "2026-11-05T01:06:31.924Z"    // 本次写入时刻
}
```

`pid` 与 `startedAt` 是给客户端判断"Harness 是不是重启过"用的：两者都没变却连不上，说明不是端口漂移。

- **token 自动生成**：插件首次激活时生成并落盘，调用方 CLI/MCP 自动读取，无需手工配置。
- **只服务 loopback**：默认仅接受 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`，其它来源 403。要开放到局域网须显式打开 `allowRemote`（见配置）。
- **健康检查故意免鉴权**：它只回 `{ok, plugin, version, protocol, authenticated}`，不泄漏任何会话或配置。

---

## 3. 方法一览

全部方法名都在 `dsh.` 命名空间下；CLI 的别名 `ping` / `discover` / `ask` / `models` 也可直接当 JSON-RPC method 用。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `dsh.discover` | — | 插件版本、传输地址、方法目录、结果结构说明 |
| `dsh.ping` | — | `{ok, plugin, version, protocol, origin, tokenSource, activeRuns}` |
| `dsh.models` | — | `{default, routableProviders, groups[], failures[]}` |
| `dsh.workspaces.list` | — | `{total, items:[{id, title, path, status, sessions, createdAt, updatedAt}]}`，`status` 为 `ok` / `missing-dir` / `unknown` |
| `dsh.workspaces.create` | `path, title?` | `{id, title, path}`：把目录登记成工作区（同路径幂等复用） |
| `dsh.permissions.catalog` | — | `{options:[{value, name, description?}], defaultPreset}`：每个预设=沙箱模式+审批策略 |
| `dsh.sessions.configure` | `sessionId, model?, reasoningEffort?, permissionPreset?` | `{sessionId, selected?, permissionPreset?}`：给已有会话换模型/推理等级/权限 |
| `dsh.sessions.list` | `limit?` | `{total, items:[{sessionId, running, blank, cwd, updatedAt, …}]}` |
| `dsh.sessions.create` | `workspaceId? \| cwd?, agentPreset?, model?, reasoningEffort?, permissionPreset?` | `{sessionId, agentPreset, cwd, selected?, permissionPreset?}`：`workspaceId` 与 `cwd` 互斥；都不传就交给 Host 决定，`cwd` 回读 Host 实际挂载的目录。**不接受 `sessionId`**——id 由 Host 分配，传了会 `-32602`，不会悄悄换成另一个 id |
| `dsh.sessions.ask` | `text, sessionId?, workspaceId? \| cwd?, agentPreset?, model?, reasoningEffort?, permissionPreset?, mode?, queue?, timeoutMs?` | 见下方**轮次结果**；`sessionId` 省略时新建会话，`created:true`。同一会话已有 bridge 在等轮次时默认返回 `-32004`，加 `queue: true` 则排队等它结束（受自己的 `timeoutMs` 约束） |
| `dsh.sessions.prompt` | `sessionId, text, mode?` | `{accepted, sessionId, requestId, mode}`，立即返回、不等轮次；**不占住会话**，所以并发的 `ask` 仍可能抢走那一轮——要结果就配 `dsh.sessions.wait` |
| `dsh.sessions.wait` | `sessionId, timeoutMs?` | 等待该会话**当前/下一个**轮次结束并返回轮次结果 |
| `dsh.sessions.cancel` | `sessionId` | `{accepted, sessionId}`：中断正在进行的轮次，保留待处理队列 |
| `dsh.sessions.history` | `sessionId, limit?` | `{cursor, turn, running, messageCount, records[]}`，只读快照 |

`mode` 取 `queue`（默认，下一轮次开始）或 `steer`（插入正在跑的轮次，当前一步之后生效）。

`limit` 必须是正整数：省略时 `dsh.sessions.list` 默认 50 条、`dsh.sessions.history` 默认 40 条；`history` 的上限是 500 条。传 `0`、负数或小数会返回 `-32602`，而不是被悄悄纠正成一个别的条数。

### 工作区、模型、推理等级、权限

这四个都是 DSH 自己的概念，桥只做转发，不新造开关。

**位置（工作区 / 目录）只在创建会话时决定。** `workspaceId` 走 `workspace.attachSession`，会话因此出现在 GUI 侧栏的对应工作区下；`cwd` 只设置目录、不挂工作区。二者互斥，同时给会被拒绝（`-32602`）。复用已有会话时再传位置参数同样被拒绝——要换位置就新建一个。`agentPreset` 同理：它决定会话用哪个 agent 预设，也只在创建时生效。

CLI 和 MCP 都不在客户端预先过滤这些参数：给了就转发，由桥给出统一的拒绝理由。这样"传了但没生效"不会伪装成"传了并生效"。

```powershell
node bin/dsh-rpc.mjs workspaces                        # 先看有哪些
node bin/dsh-rpc.mjs ask "看下这个项目" --workspace ws-1   # 进去
```

**模型与推理等级**通过 `dsh.sessions.configure` 或创建时的同名参数下发，落到 Host 的 `selectModel`：

```powershell
node bin/dsh-rpc.mjs models | head -40
node bin/dsh-rpc.mjs ask "重新想想" --session session-xxxx --model anthropic/opus-4.6 --effort high
```

- 模型名可写 `provider/model`；只写裸 id 时，桥会去模型目录里查——唯一命中就用，命中多个就报错并列出可消歧的写法，命中零个就让你去看 `dsh.models`。**不会替你猜一个。**
- `reasoningEffort` 必须和 `model` 同一次请求给出。Host 没有"读回当前模型"的接口，桥不猜。
- ⚠️ **换模型会把选择存成 profile 默认**（这是 Host 自己的行为，和你在 GUI 里换模型一样）。也就是说外部 agent 换过去之后，你在 GUI 里新开的会话也会用那个模型。

**权限预设**是"沙箱模式 + 审批策略"的组合（如 `read-only` / `workspace-write` / `danger-full-access` 配 `ask` / `never`）：

```powershell
node bin/dsh-rpc.mjs permissions
node bin/dsh-rpc.mjs ask "跑一下测试" --permission workspace-write
```

预设名会先按 Host 的 catalog 校验，未知名字直接报错并列出可选项。注意：预设只是**该会话的默认值**，不等于放行——`danger-full-access` 之类的高权限仍然取决于你在 DSH 里的审批设置。


### 轮次结果（`ask` / `wait`）

```jsonc
{
  "sessionId": "session-…",
  "turn": 2,
  "status": "completed",          // completed | aborted | blocked | error | max-tokens | interrupted | forked | idle | timeout | unknown
  "reason": { "kind": "completed" },
  "text": "收到",                  // 该轮正文，多段以空行连接
  "reasoning": "…",               // 可选，思考内容
  "tools": [],                    // [{callId, name, arguments}]，该轮的工具调用
  "usage": { "inputTokens": 134981, "outputTokens": 2, "totalTokens": 134983 },
  "durationMs": 5311,
  "timedOut": false,
  "partial": false,               // true 表示流在 turn/end 之前结束，text 只是片段
  "requestId": "rpc-…",
  "created": true,                // 本次是否新建了会话
  "cursor": 4,
  "turnStartedAt": 1793807450349
}
```

- `status` 一律来自该轮自己的 `turn/end` 原因，**不会**把被取消的轮次报成 `completed`。
- `timeout` 表示等待超时，**不会**取消该轮——必要时再调 `dsh.sessions.cancel`。
- `partial: true` 只出现在 `status:"unknown"` 时：事件流没等到 `turn/end` 就结束了，`text` 是半截，不要当完整回答用。
- `cwd` 只在 `created:true` 时回填。

**轮次归属**：`ask` 不只靠"基线轮次 + 1"的猜测。投递 prompt 后，本插件会从事件流里找自己那条 `user/message`（`source.rpcId` 等于本次请求的 `requestId`），以它落在哪一轮为准。因此**同一会话里有别人（GUI 或其他 agent）先插话时，不会把别人的回答当成你的**——那一轮的 `turn/end` 会被跳过，继续等自己那一轮。

### 流式端点

`POST /dsh-rpc/stream`，请求体与 `ask` 的参数一致，响应是每行一个 JSON 的 NDJSON：

```jsonc
{ "type": "session", "sessionId": "session-…", "cwd": "…", "agentPreset": null }   // 仅新建会话时
{ "type": "progress", "frame": { "type": "event", "event": { "type": "turn/start", … } } }
{ "type": "result", …轮次结果字段, "created": false }                                // 最后一帧
{ "type": "error", "error": { "kind": "…", "message": "…" } }                        // 或这一帧
```

客户端断开连接时，该次等待会被中止（不取消 Harness 里的轮次）。

---

## 4. 错误码

JSON-RPC 标准码之外，本插件用 `-3200x` 段表达业务语义：

| code | 含义 |
| --- | --- |
| `-32700` | 请求体不是合法 JSON |
| `-32600` | 不是合法 JSON-RPC 请求 |
| `-32601` | 未知方法 |
| `-32602` | 参数非法（缺字段、空文本、sessionId 不合法…） |
| `-32603` | 插件内部错误 |
| `-32000` | Host 侧失败（无法归类） |
| `-32001` | token 缺失或错误 |
| `-32002` | 来源不是 loopback 且未开 `allowRemote` |
| `-32003` | 会话不存在（Host `session/not-found`） |
| `-32004` | 会话忙：Host 的 `session/agent-busy`、`session/writer-held`、`session/conflict`，或同一会话已有 bridge 运行在等轮次（避免把别人的答案当成自己的） |
| `-32005` | 等待超时 |
| `-32006` | 调用被取消 |

`error.data` 里保留 `kind`（Host 的原始错误码，如 `session/not-found`）与 `details`。

---

## 5. 配置

插件通过 `cordis.patch.yml` 的一行 `config` 配置，全部有默认值，留空即用默认：

```yaml
- insert:
    - id: dsh-rpc-bridge
      name: '@punchact/dsh-rpc-agent'
      config:
        token: ''              # 留空则自动生成并落盘
        allowRemote: false     # 允许非 loopback 来源（默认关）
        defaultCwd: ''         # ask 未给 cwd 时用这个，再回落到进程 cwd
        defaultAgentPreset: '' # 新建会话的默认 preset
        defaultTimeoutMs: 600000
        maxBodyBytes: 1048576
        maxSessions: 200       # 同时进行的等待上限
```

其余键：`enabled`、`tokenFile`（自定义 token 路径）、`path`（默认 `/dsh-rpc`）、`logRequests`。

环境变量 `DSH_RPC_TOKEN` 可覆盖 token（优先级高于文件），适合 CI 或不想落盘的场景。

---

## 6. 安装与更新

**从 npm 装（推荐）**。本包是标准 DSH bundle，注册表里装和本地目录装走的是同一套 pnpm 路径：

```bash
dsh plugin add @punchact/dsh-rpc-agent
```

或在 DSH 里直接说：

```js
plugin_manager({ action: "install_bundle", target: "@punchact/dsh-rpc-agent" })
```

非默认 profile 加 `--profile <name>`（桌面端是 `desktop`）。

**从本地目录装（改源码时用）**：

```js
// 交给 DSH 自己安装（安装后会立即激活）；target 传本目录的绝对路径
plugin_manager({ action: "install_bundle",
                 target: "<absolute-path-to-your-clone>" })
```

- 这种安装是**指向本目录的链接**，改完源码不需要重装。
- 但宿主不会因文件变化重新 `import`；要让新的 `lib/*.mjs` 生效，把插件行关一次再开：

```js
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: false })
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: true  })
```

`bin/` 与 `test/` 是独立进程，改动无需重载。

**发版（仅维护者）**：见 [docs/release.md](./docs/release.md)。

---

## 7. 安全模型

**一句话：本插件的 bearer token 等价于"在这台机器上让 DSH 替你执行动作"的权限。**

拿到 token 的进程可以新建会话、投递 prompt，于是 DSH 会用**它自己的**工具去读文件、写文件、跑命令、访问网络——受 DSH 自己的沙箱与审批策略约束，但不受本插件约束。本插件只做两件事：把请求转给 Host、把结果转回来；它不额外放宽任何权限，也不替你审阅内容。

| 面 | 现状 | 说明 |
| --- | --- | --- |
| 传输 | loopback + Bearer token | 默认只接受 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`，其它来源 403 |
| token 存储 | `%USERPROFILE%\.dsh\dsh-rpc\token` | 首次启动生成 32 字节随机值，权限 0600（非 POSIX 文件系统上尽力而为） |
| token 比较 | SHA-256 + 定时安全比较 | 不按字节提前返回 |
| 免鉴权端点 | `GET /health` | 只回 `{ok, plugin, version, protocol, authenticated}`，不含会话、配置或路径 |
| 请求体上限 | 1 MiB（可配） | 超限返回 413，不会无限读入内存 |
| 来源校验 | 按 socket 的 `remoteAddress` | 不看 `X-Forwarded-For`；放在反向代理后面会一律看到代理地址 |

**没有做的事**（有意为之）：不加密传输（只服务 loopback，且不监听对外网卡）、不做速率限制、不做请求签名、默认不记录 prompt 内容（`logRequests` 显式打开才记日志头部）。

**如果要暴露到局域网**：`allowRemote: true` 只是关掉 loopback 白名单，**不会**增加任何认证强度。那种部署应放在 TLS 终止代理后面并另配访问控制；本机单用户场景之外不建议这么做。

**共享机器**：token 文件就是凭据。不要抄进 shell 历史、CI 明文变量或聊天记录；怀疑泄漏就删掉该文件并重载插件——会重新生成，旧 token 立即失效。

---

## 8. 端口与连接稳定性

DSH 的 Web 服务端口由启动器决定，桌面端交给系统分配，所以**重启后会变**。本插件不固定端口。

**为什么不在 patch 里写死**：`dsh-web-app` 的 webserver 行用 `!!js` 取 `ctx.webStartup.port ?? 3080`；而 `cordis.patch.yml` 的覆写是**整行 config 替换**，写死就要把 `host` / `tls` / `compression` 等键全部重述，官方升级引入新键时会静默丢掉。另外端口被占时 DSH 会起不来，也无法多开。相比之下让插件"跟着 DSH 走"更稳。

**端点由插件发布**：每次激活调用 `ctx.webServer.getOrigin()` 拿真实地址写进 `endpoint.json`；客户端（CLI / MCP / `lib/client.mjs`）**每次调用都重新读**，不缓存。

**重启窗口内只重试一种错**：客户端仅对 `ECONNREFUSED`（TCP 被拒、请求没发出去）重读端点重试一次；`ECONNRESET` / `EPIPE` / 超时**不重试**，因为字节可能已被对方收下，重发有重复投递 prompt 的风险。显式 `--url` 或 `DSH_RPC_URL` 也不重试——你指定了地址，答案就是那个错误。

**重启后串脚本**：

```powershell
node bin/dsh-rpc.mjs health --wait 15000; if ($?) { node bin/dsh-rpc.mjs ask "接着干" --session session-xxxx }
```

`--wait` 每 250ms 重读端点并探活，就绪返回 0（打印耗时），超时返回 3。

**仍可能失败的情形**：Harness 启动中插件尚未激活（`endpoint.json` 还是上一次的地址，`pid` 未变而端口已失效）；同时跑多个实例（单文件，后写覆盖先写）。这两种请用 `--url` 显式指定。

---

## 9. 从 GUI 跟进 CLI 发起的任务

CLI 的 stdout 只在执行它的终端里——那是**调用方进程**的输出。但被驱动的那一轮**是 Harness 里的真会话**，所以它同时出现在 GUI：

| 层 | 在哪看得到 |
| --- | --- |
| CLI 进程的 stdout / stderr / 退出码 | 只在执行它的终端 |
| 该轮的会话与完整对话 | GUI 侧栏的会话列表；点开可看 transcript、工具调用、token 用量 |

能这样是因为插件走 Host 的 `sessionController`（而不是拿一个裸 agent）：会话日志、标题生成、`running` 状态都来自同一份存储。

**三个实践要点**：

1. **总是带 `--cwd`**。不带时 Host 用进程工作目录（通常是 DSH 自己的 profile 目录），这样的会话在侧栏里不容易认出属于哪个项目。
2. **留住返回的 `sessionId`**。后续 `wait` / `history` / 续聊 / 在 GUI 里接手都靠它。
3. **GUI 不会主动弹窗**。会话只是进了列表，需要你点开。

**审批仍由 GUI 或你的策略决定**：若那一轮触发需要人工批准的工具调用，它会挂在 Host 侧等待；没人打开会话时，这一轮会一直等到 `timeoutMs` 用完——此时 `ask` 返回 `status:"timeout"`，且**不会**取消该轮（可在 GUI 里继续，或调 `dsh.sessions.cancel`）。

---

## 10. 设置页里的状态面板

装好之后，设置窗口左侧多出一项 **「RPC 桥接」**（`设置 → RPC 桥接`）。它回答的是"桥现在活着吗、刚才谁调过什么"：

| 区块 | 内容 |
| --- | --- |
| 状态灯 | 在线 / 连不上，版本号，最近一次刷新时间（页面每 2 秒拉一次） |
| 运行信息 | 端点 URL、协议版本、凭据来源（`config`/`env`/`file`/`generated`）、已服务时长、`pid`、Node 版本、是否允许远程、调用总数与失败数 |
| 正在跑的轮次 | 每个活动的 `ask`/`wait`：运行 ID 前 8 位、是否有会话、是否带提问、已跑多久 |
| 最近 12 次调用 | 时间、方法名、耗时、成功/失败与错误码 |
| 方法用量 | 按方法累计的次数与错误次数 |
| 怎么接 | 两条可直接复制的命令（MCP 注册、CLI 试一次） |
| 配置片段 | 按当前生效值生成的一段 `cordis.patch.yml` 行，一键复制——改配置去 profile 的 patch 层，页面只负责把该贴什么写给你 |

它读的是 **`GET /dsh-rpc/status`**：与 `/health` 同一信任边界——**只接受 loopback、不要 token**，因为浏览器里的页面拿不到 `endpoint.json` 里的 token。作为交换，这个端点必须"什么也不说"：

- 不含 token、不含 `sessionId`（活动轮次只给运行 ID 前 8 位与"是否有会话"）；
- 不含任何调用参数——不记 prompt 正文、不记工具参数（见 `lib/stats.mjs` 的注释）。调用记账只存**方法名、耗时、结果码**。

页面的数据全部来自这条只读接口，不写任何东西。想让面板消失就停用插件；`/status` 与页面一起下线。

> 端口变了不用管：页面请求的是固定路径 `/dsh-rpc/status`（插件在 `path` 被改时会额外保留这个别名），而状态数据里的 `origin` 永远是当前真实的监听地址。

---

## 11. 验证

```powershell
cd dsh-rpc-plugin
node test/methods.test.mjs     # 40 个单元用例，无需 Harness
node test/client.test.mjs      # 6 项客户端重试/报错用例，无需 Harness
node test/status.test.mjs      # 6 项 /status 与路由挂载用例，无需 Harness
node test/catalog.smoke.mjs    # 方法目录与三处包名一致性
npm ci && node test/host.test.mjs   # 1 项真宿主集成用例（真 WebServer，需装 devDependencies）
node test/e2e.mjs --cwd .      # 14 项端到端检查，打真实 Harness
node test/edge.mjs             # 24 项协议/边界对抗检查，打真实 Harness
```

`npm test` 跑前四个（都不需要 Harness，也不需要 `npm install`）；`npm run test:host` 跑真宿主集成那一项；`npm run test:e2e` / `npm run test:edge` 要活的 Harness。

- **单元**用 `node:test` 与一个手写的 Host 假体（含 `follow` 流、事件总线、`user/message` 认领），覆盖轮次归属、steer、超时、abort 原因、history、cancel、并发拒绝与 `queue` 排队、创建期的参数契约（含拒绝调用方自带 `sessionId`）、cwd 归属、工作区/模型/权限下发、`limit` 校验、dispatcher 错误码。必须**直接 node 运行**——`node --test` 会为每个文件 fork 子进程，在 DSH 沙箱下被 `spawn EPERM` 挡住。上次实跑：41/41（2026-11-05）。
- **客户端**用临时 `$DSH_HOME` 与本地假服务，验证重试与报错策略：端点重发后重试一次且只投递一次、`ECONNRESET` 绝不重放、显式 `--url` 不重试、重试后的失败不被改写成"没人监听"、端点未变时报错含 `pid` 与下一步建议；另有一例直接对 `lib/transport.mjs` 钉住「从 undici 的 cause 链里取真实 errno」在各平台的形状（Linux 上 `UND_ERR_SOCKET` 会归一成 `ECONNRESET`）。上次实跑：6/6（2026-11-05）。
- **状态页**用假 `webServer` 与假 `res` 钉住三件事：`/status` 的载荷只有聚合数据（断言 token、`sessionId`、prompt 正文都不出现）、非 loopback 一律 403 且非 GET/HEAD 得 405、以及**路由挂载契约**（同一次进程内第二代能接管上一代的路由而不撞 `duplicate exact route`；挂载中途失败会整段回滚；只有当前属主能真正卸载）。上次实跑：6/6（2026-11-05）。
- **真宿主集成**不用假 `webServer`：`new Context()` + `ctx.plugin(WebServer, {host:'127.0.0.1', port: 0})` 起真监听，再 `apply()`，然后真发 HTTP 断言 `/health` 200、无 token 的 RPC 401、`/status` 的 `origin` 与真实监听一致、前缀内未注册路径 404，**最后跑插件自己的 disposer 并断言 `/health` 与 `/status` 都变 404**。这是唯一能抓住"上一代路由残留导致重载失败"这一真实事故的测试。上次实跑：1/1（2026-11-05）。
- **端到端**走的是与外部 agent 完全相同的 `lib/client.mjs`，因此跑绿即证明 plugin → Host `sessionController` → HTTP → JSON-RPC → 调用方 整条链路成立。上次实跑：14/14（2026-11-05）。
- **边界**检查协议层：batch、通知、id 形态、鉴权头、超大 body（应得真正的 413 而不是断连）、参数注入防护、超时钳制、并发 ask、`limit` 语义。上次实跑：24/24（2026-11-05）。
- **端口漂移**（手工）：把 `endpoint.json` 的 url 改成死端口再跑 `dsh-rpc ping`，应得退出码 3 与含 `nothing is listening`、`pid`、`health --wait` 的可读报错；把文件恢复后 `ping` 立刻正常。2026-11-05 实跑符合预期。
- **显示核验**：Plugins 页里的插件行标题与图标已目视确认（显示为 `RPC Bridge` + 本包图标，2026-11-05）。注意 `plugin_manager list_bundles` 输出的是 `package.json` 的 `description` 字段，和前台显示不是同一来源，别拿它当 locale 生效的证据。

---

## 12. 已知边界

- **同一会话只允许一个「提问型」运行**：本插件的两个 `ask` 并发时，第二个默认直接返回 `-32004`；加 `queue: true` 则排队等前一个结束（在它自己的 `timeoutMs` 内，超时给 `-32005`）。排队期间在 `ping`/状态页里能看到 `state: "queued"`。注意这只约束本插件——GUI 或别的 agent 仍可以在同一会话插话；轮次归属靠 `user/message` 里的 `rpcId` 认领（见第 3 节），不会把别人的回答当成你的，代价是那一轮要等它跑完才能轮到你。`wait` 不受限，可随时挂上去看。
- **`wait` 只看得见快照窗口**：`wait` 靠 `follow` 的首帧快照判断「当前/最后一轮」，窗口上限 500 条事件（`maxMessages`）。极长会话若快照已截断到目标轮次之前，可能把状态报成 `completed`（而非那一轮真实的 `aborted`/`blocked`）；要精确值就带上 `sessionId` 调 `history` 复核。
- **批量请求串行执行**：一个 HTTP batch 里的多条 JSON-RPC **按顺序**执行（不是并发），一条慢 `ask` 会挡住同批后续请求。要并发请用多个连接。
- **不复制审批策略**：Harness 侧仍按它自己的审批与沙箱策略执行；需要人工批准的工具有可能让该轮长时间挂起（受 `timeoutMs` 约束）。`permissionPreset` 下发的只是该会话的默认预设，不是放行。
- **位置只在创建时决定**：`workspaceId` / `cwd` 对已有会话无效，桥会直接拒绝而不是默默忽略。换位置 = 新建会话（旧会话留在原处）。
- **换模型会改 profile 默认**：`selectModel` 是 Host 的模型切换入口，它会把选择存成 profile 默认（和 GUI 里换模型同一行为）。外部 agent 换过之后，你在 GUI 新开的会话也会用那个模型。
- **权限预设依赖可选服务**：本部署若没有 `permissionPresets` 服务，传 `permissionPreset` 会得到 `-32000` 并说明原因，而不是静默跳过。
- **工作区只增不删**：桥只暴露 `workspaces.list` / `workspaces.create`；删除与改名请用 GUI，避免外部 agent 误删你侧栏里的条目。
- **只转发 Host 允许的会话**：`sessions.list` 与 `history` 经过 Host 的 `remoteAccess` 过滤，看到的就是本进程有权看到的会话。
- **正文截断**：单轮保留的事件有上限（4000 条），超长会话的 `text` 仍完整（来自 `assistant/message`），但 `tools` 列表可能被截断。
- **token 泄漏面**：token 落盘在 `%USERPROFILE%\.dsh\dsh-rpc\token`，与 DSH 其它凭据同级；共享机器上注意 ACL。
- **未声明 `Config` schema**：插件用手写校验读 row 的 `config`，而不是导出 `Config`（保持零依赖，避免在 profile 里依赖 schemastery 的 peer 解析）。代价是 `cordis_inspect_query` 里这行显示 `status: absent`，也没有可视化表单；配置项与默认值见第 5 节。

---

## 13. 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| `dsh-rpc: 401` | token 不匹配。删掉 `%USERPROFILE%\.dsh\dsh-rpc\token` 后重载插件即重新生成 |
| `403` | 来源不是 loopback；确认没走代理，或打开 `allowRemote` |
| `-32004 … already has a bridge run waiting for its turn` | 同一会话已有 `ask`/`prompt` 在等轮次；换一个会话，或等它结束（`wait` 可并行观察） |
| `3 · 连不上` | Harness 没在跑，或插件的行被禁用；`node bin/dsh-rpc.mjs health` 先探活 |
| 改了源码但行为没变 | 宿主缓存了模块：`set_plugin` 关一次再开 |
| `Cannot read properties of undefined (reading 'throwIfAborted')` | 旧版本把 Host 的 `prompt/list` 用 `undefined` 调用；已修（Host 这些方法的 `signal` 是必需的） |
| 插件行状态 `absent` | 正常：插件不导出 `Config` schema，`cordis_inspect_query` 里没有 config 契约 |
