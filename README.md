# @punchact/dsh-rpc

把 DeepSeek Harness 变成本机可调用的 **RPC 服务**：任何本地 agent（Claude Code、Codex CLI、Cursor、Trae、自己写的脚本）都能把任务交给 DSH，拿回它的最终回答。

DSH 在这里不是一个模型，而是一个**完整的 agent**——带自己的工具、技能、MCP 服务器、沙箱与会话上下文。调用方只需要一句 HTTP 或一个 MCP 工具。

```
Claude Code / Cursor / Codex ──┐
dsh-rpc CLI ───────────────────┼──► http://127.0.0.1:6695/dsh-rpc ──► DSH agent
自己的脚本 (import lib/client) ─┘        JSON-RPC 2.0 + Bearer token
```

---

## 1. 四条接入路径

| 方式 | 适合 | 入口 |
| --- | --- | --- |
| **MCP 工具** | Claude Code、Cursor、Codex 等支持 MCP 的 agent | `bin/dsh-rpc-mcp.mjs` |
| **CLI** | 人在终端里试、脚本里 `$(...)` 取值 | `bin/dsh-rpc.mjs` |
| **HTTP JSON-RPC** | 任何语言的进程 | `POST http://127.0.0.1:6695/dsh-rpc` |
| **JS 客户端库** | Node 侧集成 | `import { rpcCall, rpcStream } from "@punchact/dsh-rpc/client"` |

### MCP（推荐）

```powershell
claude mcp add dsh -- node "<path-to-your-clone>\bin\dsh-rpc-mcp.mjs"
```

Cursor / Codex 用配置文件等价写法：

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["<absolute-path-to-your-clone>\\bin\\dsh-rpc-mcp.mjs"]
    }
  }
}
```

暴露 5 个工具：`dsh_ask`、`dsh_sessions`、`dsh_wait`、`dsh_cancel`、`dsh_status`。`dsh_ask` 返回 Harness 的正文，加一行 `— session … · turn … · completed · 5.2s` 元信息。

工具参数是 snake_case（MCP 侧习惯），和 HTTP 层不同：

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `dsh_ask` | `prompt`（**必填**）、`session_id?`、`agent_preset?`、`timeout_ms?` | 提问一轮并等结果；`session_id` 省略即新建会话 |
| `dsh_sessions` | `limit?` | 列出会话 |
| `dsh_wait` | `session_id`（必填）、`timeout_ms?` | 等该会话当前/下一轮结束 |
| `dsh_cancel` | `session_id`（必填） | 中断正在跑的轮次 |
| `dsh_status` | — | `ping` 的等价物，用于确认端点与 token 可读 |

> 参数名写错时报文很直接，例如给 `dsh_ask` 传 `text` 会得到 `` `prompt` is required ``，`isError:true`。

> MCP 服务器与被调用的 Harness 会话**不共享上下文**。给 `dsh_ask` 的 prompt 要自包含；要延续同一会话就把上次返回的 `session_id` 传回去。

### CLI

```powershell
node bin/dsh-rpc.mjs health            # 免鉴权探活
node bin/dsh-rpc.mjs ping              # 带 token 的真实调用
node bin/dsh-rpc.mjs ask "只回复两个字：收到" --cwd . --json
node bin/dsh-rpc.mjs ask "接着上一句" --session session-xxxx --json
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
$token = (Get-Content "$env:USERPROFILE\.dsh\dsh-rpc\token" -Raw).Trim()
$body = @{ jsonrpc = "2.0"; id = 1; method = "dsh.sessions.ask";
           params = @{ text = "只回复两个字：收到"; cwd = "C:\path\to\work" } } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:6695/dsh-rpc `
  -Headers @{ Authorization = "Bearer $token" } -ContentType application/json -Body $body
```

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
| RPC 端点 | `POST http://127.0.0.1:6695/dsh-rpc`（JSON-RPC 2.0） |
| 流式端点 | `POST http://127.0.0.1:6695/dsh-rpc/stream`（NDJSON） |
| 探活 | `GET http://127.0.0.1:6695/dsh-rpc/health`（**免鉴权**） |
| 凭据 | `Authorization: Bearer <token>`，或 `X-DSH-RPC-Token: <token>` |
| token 文件 | `%USERPROFILE%\.dsh\dsh-rpc\token`（32 字节随机 hex，权限 0600） |
| 端点描述 | `%USERPROFILE%\.dsh\dsh-rpc\endpoint.json`（插件启动时自动写入） |

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
| `dsh.sessions.list` | `limit?` | `{total, items:[{sessionId, running, blank, cwd, updatedAt, …}]}` |
| `dsh.sessions.create` | `cwd?, agentPreset?` | `{sessionId, agentPreset, cwd}`：`cwd` 不传就交给 Host 决定，结果回读 Host 实际挂载的目录 |
| `dsh.sessions.ask` | `text, sessionId?, cwd?, agentPreset?, mode?, timeoutMs?` | 见下方**轮次结果**；`sessionId` 省略时新建会话，`created:true`。同一会话已有 bridge 在等轮次时返回 `-32004` |
| `dsh.sessions.prompt` | `sessionId, text, mode?` | `{accepted, sessionId, requestId, mode}`，立即返回、不等轮次 |
| `dsh.sessions.wait` | `sessionId, timeoutMs?` | 等待该会话**当前/下一个**轮次结束并返回轮次结果 |
| `dsh.sessions.cancel` | `sessionId` | `{accepted, sessionId}`：中断正在进行的轮次，保留待处理队列 |
| `dsh.sessions.history` | `sessionId, limit?` | `{cursor, turn, running, messageCount, records[]}`，只读快照 |

`mode` 取 `queue`（默认，下一轮次开始）或 `steer`（插入正在跑的轮次，当前一步之后生效）。

`limit` 必须是正整数：省略时 `dsh.sessions.list` 默认 50 条、`dsh.sessions.history` 默认 40 条；`history` 的上限是 500 条。传 `0`、负数或小数会返回 `-32602`，而不是被悄悄纠正成一个别的条数。

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
      name: '@punchact/dsh-rpc'
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

```js
// 交给 DSH 自己安装（安装后会立即激活）
plugin_manager({ action: "install_bundle",
                 target: "<absolute-path-to-your-clone>" })
```

- 安装是**指向本目录的链接**，改完源码不需要重装。
- 但宿主不会因文件变化重新 `import`；要让新的 `lib/*.mjs` 生效，把插件行关一次再开：

```js
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: false })
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: true  })
```

`bin/` 与 `test/` 是独立进程，改动无需重载。

---

## 7. 验证

```powershell
cd dsh-rpc-plugin
node test/methods.test.mjs     # 21 个单元用例，无需 Harness
node test/e2e.mjs --cwd .      # 14 项端到端检查，打真实 Harness
node test/edge.mjs             # 24 项协议/边界对抗检查，打真实 Harness
```

- **单元**用 `node:test` 与一个手写的 Host 假体（含 `follow` 流、事件总线、`user/message` 认领），覆盖轮次归属、steer、超时、abort 原因、history、cancel、并发拒绝、cwd 归属、`limit` 校验、dispatcher 错误码。必须**直接 node 运行**——`node --test` 会为每个文件 fork 子进程，在 DSH 沙箱下被 `spawn EPERM` 挡住。上次实跑：21/21。
- **端到端**走的是与外部 agent 完全相同的 `lib/client.mjs`，因此跑绿即证明 plugin → Host `sessionController` → HTTP → JSON-RPC → 调用方 整条链路成立。上次实跑：14/14。
- **边界**检查协议层：batch、通知、id 形态、鉴权头、超大 body（应得真正的 413 而不是断连）、参数注入防护、超时钳制、并发 ask、`limit` 语义。上次实跑：24/24。
- **显示核验**：Plugins 页里的插件行标题与图标已目视确认（显示为 `RPC Bridge` + 本包图标，2026-11-05）。注意 `plugin_manager list_bundles` 输出的是 `package.json` 的 `description` 字段，和前台显示不是同一来源，别拿它当 locale 生效的证据。

---

## 8. 已知边界

- **同一会话只允许一个「提问型」运行**：本插件的两个 `ask`/`prompt` 并发时第二个直接返回 `-32004`。注意这只约束本插件——GUI 或别的 agent 仍可以在同一会话插话；轮次归属靠 `user/message` 里的 `rpcId` 认领（见第 3 节），不会把别人的回答当成你的，代价是那一轮要等它跑完才能轮到你。`wait` 不受限，可随时挂上去看。
- **`wait` 只看得见快照窗口**：`wait` 靠 `follow` 的首帧快照判断「当前/最后一轮」，窗口上限 500 条事件（`maxMessages`）。极长会话若快照已截断到目标轮次之前，可能把状态报成 `completed`（而非那一轮真实的 `aborted`/`blocked`）；要精确值就带上 `sessionId` 调 `history` 复核。
- **批量请求串行执行**：一个 HTTP batch 里的多条 JSON-RPC **按顺序**执行（不是并发），一条慢 `ask` 会挡住同批后续请求。要并发请用多个连接。
- **不复制审批策略**：Harness 侧仍按它自己的审批与沙箱策略执行；需要人工批准的工具有可能让该轮长时间挂起（受 `timeoutMs` 约束）。
- **只转发 Host 允许的会话**：`sessions.list` 与 `history` 经过 Host 的 `remoteAccess` 过滤，看到的就是本进程有权看到的会话。
- **正文截断**：单轮保留的事件有上限（4000 条），超长会话的 `text` 仍完整（来自 `assistant/message`），但 `tools` 列表可能被截断。
- **token 泄漏面**：token 落盘在 `%USERPROFILE%\.dsh\dsh-rpc\token`，与 DSH 其它凭据同级；共享机器上注意 ACL。
- **未声明 `Config` schema**：插件用手写校验读 row 的 `config`，而不是导出 `Config`（保持零依赖，避免在 profile 里依赖 schemastery 的 peer 解析）。代价是 `cordis_inspect_query` 里这行显示 `status: absent`，也没有可视化表单；配置项与默认值见第 5 节。

---

## 9. 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| `dsh-rpc: 401` | token 不匹配。删掉 `%USERPROFILE%\.dsh\dsh-rpc\token` 后重载插件即重新生成 |
| `403` | 来源不是 loopback；确认没走代理，或打开 `allowRemote` |
| `-32004 … already has a bridge run waiting for its turn` | 同一会话已有 `ask`/`prompt` 在等轮次；换一个会话，或等它结束（`wait` 可并行观察） |
| `3 · 连不上` | Harness 没在跑，或插件的行被禁用；`node bin/dsh-rpc.mjs health` 先探活 |
| 改了源码但行为没变 | 宿主缓存了模块：`set_plugin` 关一次再开 |
| `Cannot read properties of undefined (reading 'throwIfAborted')` | 旧版本把 Host 的 `prompt/list` 用 `undefined` 调用；已修（Host 这些方法的 `signal` 是必需的） |
| 插件行状态 `absent` | 正常：插件不导出 `Config` schema，`cordis_inspect_query` 里没有 config 契约 |
