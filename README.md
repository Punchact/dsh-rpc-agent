# dsh-rpc-agent

> 把本机的 DeepSeek Harness 变成一个可调用的 RPC / MCP 服务：Claude Code、Cursor、Codex、Trae，或你自己写的脚本，都能把任务交给 DSH，再拿回它的结果。

[![npm version](https://img.shields.io/npm/v/@punchact/dsh-rpc-agent)](https://www.npmjs.com/package/@punchact/dsh-rpc-agent)
[![npm downloads](https://img.shields.io/npm/dm/@punchact/dsh-rpc-agent)](https://www.npmjs.com/package/@punchact/dsh-rpc-agent)
[![unpacked size](https://img.shields.io/npm/unpacked-size/@punchact/dsh-rpc-agent)](https://www.npmjs.com/package/@punchact/dsh-rpc-agent?activeTab=code)
[![node](https://img.shields.io/node/v/@punchact/dsh-rpc-agent)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/@punchact/dsh-rpc-agent)](./LICENSE)

[English](./README.en.md) · [设计说明](./docs/design.md) · [变更记录](./CHANGELOG.md) · [发版手册](./docs/release.md) · [安全策略](./SECURITY.md)

> [!IMPORTANT]
> **与 DeepSeek 官方无关。** 这是第三方插件，由社区独立维护，不获 DeepSeek 背书。
>
> **拿到 token 就等于拿到"在这台机器上让 DSH 替你执行动作"的权限。** 装之前请读[安全模型](#安全模型)。

## 60 秒上手

```powershell
# 1. 装进 DSH 的 profile（默认 profile 是 desktop）
dsh plugin add @punchact/dsh-rpc-agent

# 2. 确认它在跑。端口每次启动都可能变，这条命令会打印当前地址
node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\bin\dsh-rpc.mjs" ping

# 3. 把 MCP 入口注册给你的 agent（这里是 Claude Code，Cursor/Codex 见下文）
claude mcp add dsh -- node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\bin\dsh-rpc-mcp.mjs"
```

然后在你的 agent 里说一句「用 `dsh_ask` 问 DSH：只回复两个字：收到」，或者直接用 CLI：

```powershell
# 上一条里那个 dsh-rpc.mjs 的完整路径，收进变量省点打字
$cli = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\bin\dsh-rpc.mjs"
node $cli ask "只回复两个字：收到" --cwd . --json
```

`ask` 默认**不阻塞**，立刻返回句柄；要看结果用 `dsh_wait` / `wait --session …`。这是刻意的——外层 agent 的工具调用通常有 300 秒硬上限，长任务必须能"先接单、后交货"。

## 它是什么

DSH 在这里不是一个模型，而是一个**完整的 agent**——带自己的工具、技能、MCP 服务器、沙箱与会话上下文。本插件只做一件很薄的事：把 HTTP 或 MCP 上的一句话转成 Host 的一次提问，再把结果转回来。

```
client (Claude Code / Cursor / Codex / CLI / your script)
    |
    |  JSON-RPC 2.0 over HTTP + Bearer token
    v
http://127.0.0.1:<port>/dsh-rpc   ->   DSH agent
```

端口**不是固定的**：DSH 每次启动由系统分配，重启后就变。`ping` 打印的 `origin` 是当前地址，插件同时把它写进 `endpoint.json`，客户端每次调用现读（见[端口与连接稳定性](#端口与连接稳定性)）。

**它不是什么**：

| 你可能想用它做 | 更好的选择 |
| --- | --- |
| 就问一句、看个回答 | 直接在 DSH GUI 里问，不必绕一层 |
| 定时、后台、报警式的任务 | DSH 自己的定时任务机制，不是本插件职责 |
| 从另一台机器驱动这台 DSH | 本插件为 loopback 设计，`allowRemote` 只关白名单、不增强认证 |

仓库与包名都是 `dsh-rpc-agent`；命令行（`dsh-rpc`、`dsh-rpc-mcp`）、端点路径（`/dsh-rpc`）、状态目录（`~/.dsh/dsh-rpc`）与 `DSH_RPC_*` 环境变量属运行时契约，改名会让已装好的配置与已配对的 token 一起失效。

## 亮点

- **零运行期依赖**：装进 profile 只多一个包，不引入 peer 解析或版本冲突。
- **会话是真的**：走 Host 的 `sessionController`，所以同一轮在 GUI 侧栏看得到、能接手、有日志与用量。
- **长任务不会被误判成失败**：非阻塞句柄 + `wait` 增量 + 明确的 `outcome:` / `note:` / `next:`，不触发外层重试。
- **跨重启不丢**：粘性会话表、升权台账、"放宽未还"的欠账都落盘，重启后继续。
- **无人值守也不卡死**：`approvals.mode` 三档，`delegate` 把升权决定交给派发方。
- **调用方断开就停手，但不杀你的工作**：abort ≠ cancel，那一轮还在 GUI 里跑。
- **端口随启动器走**：`endpoint.json` + `health --wait`，客户端不用写死地址。
- **每条对外承诺都有用例守着**：183 例单元 + 变异验证 + 真宿主集成测试。

## 安装与更新

**从 npm 装（推荐）**。本包是标准 DSH bundle，注册表装与本地目录装走同一套 pnpm 路径：

```bash
dsh plugin add @punchact/dsh-rpc-agent
```

或在 DSH 里直接说：

```js
plugin_manager({ action: "install_bundle", target: "@punchact/dsh-rpc-agent" })
```

非默认 profile 加 `--profile <name>`；钉版本写全 `@punchact/dsh-rpc-agent@0.7.7`，不写则取 `latest`。npm 上最新是 [`0.7.7`](https://www.npmjs.com/package/@punchact/dsh-rpc-agent)，本文件描述的是**仓库当前代码**，两者差异见 [CHANGELOG](./CHANGELOG.md) 顶部。

三件在 npm 路线上容易踩的事：

1. **装进来的是拷贝，不是链接。** 装完再改本地工作区的源码**不会**影响运行中的插件。要边改边试就用下面那条路线。
2. **刚发布的版本可能被 pnpm 的冷静期拦下。** 发布当天用注册表 spec 装会失败（`minimumReleaseAge` 未满）。要么钉一个已过窗口的版本，要么在 profile 的 `pnpm-workspace.yaml` 里显式放行——pnpm 有时会自己追加这一行：

   ```yaml
   minimumReleaseAgeExclude:
     - '@punchact/dsh-rpc-agent@0.4.1 || 0.4.4 || 0.5.3 || 0.7.6 || 0.7.7'
   ```

3. **想确认装的是哪一份**：用 `cordis_inspect_query`（`Config.listConfigs`，`input: {"entry":"include:dsh-rpc-bridge"}`）看返回的 `packageDir`——指向 `<profile>\node_modules\@punchact\dsh-rpc-agent` 是 npm 路线，指向你的工作区是链接路线。**版本号本身不能当证据**，它读的是包里那个 `package.json`。

版本历史见 [Releases](https://github.com/Punchact/dsh-rpc-agent/releases)；**0.4.4 起每版都由 OIDC 发布并带 SLSA provenance**（`/-/npm/v1/attestations/@punchact%2Fdsh-rpc-agent@<版本>` 返回 200）。`0.4.1` / `0.4.2` 已撤回，注册表上取不到。

**从本地目录装（改源码时用）**：

```js
plugin_manager({ action: "install_bundle", target: "<absolute-path-to-your-clone>" })
```

- 这种安装是**指向本目录的链接**，改完源码不需要重装。
- 但宿主不会因文件变化重新 `import`；要让新的 `lib/*.mjs` 生效，把插件行关一次再开：

```js
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: false })
plugin_manager({ action: "set_plugin", target: "include:dsh-rpc-bridge", enabled: true  })
```

`bin/` 与 `test/` 是独立进程，改动无需重载。发版流程见 [docs/release.md](./docs/release.md)。

## 四条接入路径

| 方式 | 适合 | 入口 |
| --- | --- | --- |
| MCP 工具 | Claude Code、Cursor、Codex 等支持 MCP 的 agent | `bin/dsh-rpc-mcp.mjs` |
| CLI | 人在终端里试、脚本里取值 | `bin/dsh-rpc.mjs` |
| HTTP JSON-RPC | 任何语言的进程 | `POST /dsh-rpc` |
| JS 客户端库 | Node 侧集成 | `@punchact/dsh-rpc-agent/http-client` |

### MCP（推荐）

`bin/` 指**包内**的 `bin/` 目录。从 npm 装时它在 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\` 下。

```powershell
claude mcp add dsh -- node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\bin\dsh-rpc-mcp.mjs"
```

Cursor / Codex 用配置文件等价写法（Windows 下 JSON 里的反斜杠要转义）：

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

走本地克隆那条路线时，把路径换成 `<path-to-your-clone>\bin\dsh-rpc-mcp.mjs`。本文余下示例写 `node bin/...`，等价于"当前目录位于包内时执行"。

暴露 **9 个工具**：

| 工具 | 用途 |
| --- | --- |
| `dsh_ask` | 提一个问题/任务；默认不等待，返回句柄 |
| `dsh_wait` | 等该会话这一轮结束并取结果 |
| `dsh_cancel` | 中断正在跑的轮次 |
| `dsh_sessions` | 列会话（可按目录过滤、按时间排序） |
| `dsh_workspaces` | 列工作区，或登记一个新工作区 |
| `dsh_permissions` | 列权限预设（沙箱模式 + 审批策略） |
| `dsh_status` | 确认端点与 token 可读 |
| `dsh_approvals_pending` | 列出待你回答的升权请求 |
| `dsh_approvals_resolve` | 回答一条升权请求 |

参数是 snake_case（MCP 侧习惯），与 HTTP 层不同。`dsh_ask` 的常用参数：

| 参数 | 说明 |
| --- | --- |
| `prompt`（**必填**） | 要交给 DSH 的那句话；要自包含 |
| `project?` | 粘性会话的键（见下） |
| `session_id?` | 复用已有会话 |
| `wait?` | **默认 `false`**：立刻返回句柄；`true` 才阻塞等这一轮 |
| `mode?` | `turn`（默认）/ `steer` / `queue` |
| `cwd?` / `workspace_id?` / `agent_preset?` | 只在新建会话时有效，前两者互斥 |
| `model?` / `reasoning_effort?` / `permission?` | 会话级设置，复用会话时也能改 |
| `timeout_ms?` | 这一轮的等待预算 |

`dsh_ask` 的结果第一行固定是 `session <id>`，随后是正文与一行 `— outcome: … · turn … · 5.2s` 元信息。参数名写错时报文很直接：给 `dsh_ask` 传 `text` 会得到 `` `prompt` is required ``，且 `isError: true`。

MCP 服务器与被调用的 Harness 会话**不共享上下文**——给 `dsh_ask` 的 prompt 要自包含。

### 粘性会话

`dsh_ask` 不带 `session_id` 时不会盲目新建：它按 `${客户端名}::${project ?? cwd}` 查 `~/.dsh/dsh-rpc/sessions.json`，命中且会话还在、还不是空会话，就**接着用同一个会话**；否则新建并回写。同一个 `project` 的第二次调用会落在上次那个会话里——这就是"一个项目一个会话"。

| 参数 | 取值 | 语义 |
| --- | --- | --- |
| `project` | 任意稳定标签 | 粘性键；省略时退到 `cwd` |
| `reuse` | `auto`（默认）/ `never` / `latest` | 用表里的会话 / 永远新建 / 按 `updatedAt` 取该项目最近的 |

两条边界：**不同客户端互不继承**（`clientInfo.name` 是命名空间的一部分）；表里记的会话若已被删或仍是空会话，就新建而不是报错。表按 0600 原子写，损坏只退回"没有记录"。

单个会话攒太久会变成上下文负担，所以同一键累计 **200 次** `ask` 后自动轮换：新建会话、把旧 id 放在结果的 `previousSessionId` 里（`rotated: true`）。这个阈值数的是**本桥投递的次数**，不是宿主总消息数——宿主没有廉价的计数接口。

### CLI

```powershell
node bin/dsh-rpc.mjs health                  # 免鉴权探活
node bin/dsh-rpc.mjs health --wait 15000     # 刚重启完时轮询到就绪再返回
node bin/dsh-rpc.mjs ping                    # 带 token 的真实调用
node bin/dsh-rpc.mjs workspaces              # 列出侧栏里的工作区
node bin/dsh-rpc.mjs permissions             # 权限预设（* 为默认）
node bin/dsh-rpc.mjs ask "只回复两个字：收到" --cwd . --json
node bin/dsh-rpc.mjs ask "看看这个工作区" --workspace ws-xxxx --json
node bin/dsh-rpc.mjs ask "接着上一句" --session session-xxxx --json
node bin/dsh-rpc.mjs ask "换 Opus 想想" --session session-xxxx --model anthropic/opus-4.6 --effort high
node bin/dsh-rpc.mjs prompt "长时间任务…" --session session-xxxx
node bin/dsh-rpc.mjs wait --session session-xxxx --timeout 600000
node bin/dsh-rpc.mjs wait --session session-xxxx --since 42   # 只要游标 42 之后的增量
node bin/dsh-rpc.mjs history --session session-xxxx --limit 20
node bin/dsh-rpc.mjs sessions --limit 10
node bin/dsh-rpc.mjs models                  # DSH 可选模型
node bin/dsh-rpc.mjs discover                # 自描述：方法、传输、结果结构
node bin/dsh-rpc.mjs cancel --session session-xxxx
node bin/dsh-rpc.mjs call dsh.sessions.history '{"sessionId":"session-xxxx"}' --timeout 30000
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

`endpoint.json` 由插件每次启动重写，所以这样取地址不需要知道端口。

### JS 客户端库

```js
import { rpcCall } from "@punchact/dsh-rpc-agent/http-client";

const answer = await rpcCall("dsh.sessions.ask", { text: "总结一下这个仓库", cwd: process.cwd() });
console.log(answer.text, answer.usage);
```

这个子路径由 `exports` 声明（`"./http-client": "./lib/client.mjs"`）。本地克隆里等价于 `import … from "<path-to-your-clone>/lib/client.mjs"`。`rpcCall` 直接 resolve 成方法的 `result`；失败时抛出的 Error 带 `code` / `data` / `status`，可按错误码分支。

## 方法

全部方法都在 `dsh.` 命名空间下；CLI 别名 `ping` / `discover` / `ask` / `models` 也可直接当 JSON-RPC method 用。

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `dsh.discover` | — | 版本、运行配置、传输地址、方法目录 |
| `dsh.ping` | — | `{ok, plugin, version, protocol, origin, tokenSource, activeRuns}` |
| `dsh.models` | — | `{default, routableProviders, groups[], failures[]}` |
| `dsh.workspaces.list` | — | `{total, items[]}`，每项含 id / title / path / status / 会话数 |
| `dsh.workspaces.create` | `path, title?` | `{id, title, path}`；同路径幂等复用 |
| `dsh.permissions.catalog` | — | `{options[], defaultPreset}`，每项带 `cost` 一句 |
| `dsh.approvals.pending` | `sessionId?, waitMs?` | `{pending[], count, timedOut, mode, deadlineMs}` |
| `dsh.approvals.resolve` | `approvalId, decision, note?` | `{approvalId, sessionId, toolName, decision, note}` |
| `dsh.sessions.configure` | `sessionId, model?, reasoningEffort?, permissionPreset?` | 已应用的设置 |
| `dsh.sessions.list` | `limit?, cwd?, sort?` | `{total, sort, cwd, items[]}` |
| `dsh.sessions.create` | `workspaceId? \| cwd?, agentPreset?, model?, reasoningEffort?, permissionPreset?` | `{sessionId, agentPreset, cwd, …}` |
| `dsh.sessions.ask` | 见下 | 轮次结果，或句柄（`wait:false`） |
| `dsh.sessions.prompt` | `sessionId, text, mode?, model?, …` | `{accepted, sessionId, requestId, mode}`，立即返回 |
| `dsh.sessions.wait` | `sessionId, timeoutMs?, since?` | 轮次结果 |
| `dsh.sessions.cancel` | `sessionId` | `{accepted, sessionId}` |
| `dsh.sessions.history` | `sessionId, limit?` | `{cursor, turn, running, messageCount, records[]}` |

几处容易踩的语义：

- **`dsh.sessions.create` 不接受 `sessionId`**：id 由 Host 分配，传了会 `-32602`，不会悄悄换成另一个 id。
- **`dsh.sessions.list` 的 `createdAt` 通常是 `null`**：本机实测宿主 `list()` 只返回 `updatedAt`，所以按 `createdAt` 排序等于保持宿主原序。
- **`dsh.sessions.ask` 的 `wait` 默认 `true`**（只有 MCP 工具 `dsh_ask` 默认 `false`——协议方法不跨小版本改形状）。同一会话已有 bridge 在等轮次时默认返回 `-32004`；加 `queue: true` 则排队等它结束。
- **`dsh.sessions.prompt` 不占住会话**：它立即返回、不等轮次，所以并发的 `ask` 仍可能抢走那一轮——要结果就配 `dsh.sessions.wait`。`model` 等会话级设置在这里就生效。
- **`limit` 必须是正整数**：`list` 默认 50、`history` 默认 40、上限 500。传 `0`、负数或小数返回 `-32602`，不会被悄悄纠正。

`mode` 取 `turn`（默认：只在会话空闲时投递，正在跑就返回 `-32004` 并附 `data.next`）、`steer`（插入正在跑的轮次）、`queue`（等当前轮次结束）。`turn` 是桥自己的判据——宿主只认 `steer` / `queue`，桥在投递前用基线快照判断。给别的值返回 `-32602`，不会悄悄降级。

**错误码**（`error.data` 里保留 Host 的原始 `kind` 与 `details`）：

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
| `-32004` | 会话忙：`session/agent-busy`、`session/writer-held`、`session/conflict`，或同一会话已有 bridge 在等轮次 |
| `-32005` | 等待超时 |
| `-32006` | 调用被取消 |

**MCP 层**：工具结果**只在调用本身失败时**才是错误（错误码 + `next:` 提示）。轮次的 `status` 一律写进正文 `outcome:` 行；除 `completed` 外每种结束原因都额外给 `note:`（人话解释）与 `next:`（下一步）。遇到本插件不认识的 `kind` 不是异常——宿主的 `TurnEndReasonMap` 可合并扩展，这类结局一律降级为"unverified，先查 `dsh_sessions()`"，绝不冒充 `completed`。

### 流式端点

`POST /dsh-rpc/stream`，请求体与 `ask` 的参数一致，响应是每行一个 JSON：

```jsonc
{ "type": "session", "sessionId": "session-…", "cwd": "…", "agentPreset": null }   // 仅新建会话时
{ "type": "progress", "frame": { "type": "event", "event": { "type": "turn/start" } } }
{ "type": "result", "sessionId": "session-…", "status": "completed" }              // 最后一帧
{ "type": "error", "error": { "kind": "…", "message": "…" } }                      // 或这一帧
```

客户端断开时，该次等待会被中止（不取消 Harness 里的轮次）。

## 轮次结果与等待

`ask`（阻塞）与 `wait` 返回同一种结构：

```jsonc
{
  "sessionId": "session-…",
  "turn": 2,
  "status": "completed",          // completed | aborted | blocked | error | max-tokens | interrupted | forked | idle | timeout | unknown | waiting-approval
  "reason": { "kind": "completed" },
  "text": "收到",                  // 该轮正文，多段以空行连接
  "reasoning": "…",               // 可选，思考内容
  "tools": [],                    // [{callId, name, arguments, output?, isError?}]
  "usage": { "inputTokens": 134981, "outputTokens": 2, "totalTokens": 134983 },
  "durationMs": 5311,
  "timedOut": false,
  "partial": false,               // true 表示流在 turn/end 之前结束，text 只是片段
  "sandbox": {                    // 仅当这一轮被沙箱拒绝时出现
    "denied": true,
    "marker": "[sandbox: file access denied under workspace-write mode]",
    "source": "tool"              // "tool" = 工具输出里读到的（可靠）；"text" = 只从回答里读到
  },
  "next": {                       // 随 sandbox 或 waiting-approval 出现
    "tool": "dsh_ask",
    "reason": "The turn was blocked by the DSH sandbox. …",
    "args": { "session_id": "session-…" }
  },
  "requestId": "rpc-…",
  "created": true,                // 本次是否新建了会话
  "cursor": 4,
  "since": 4,                     // 只有传了 since 才出现
  "turnStartedAt": 1793807450349
}
```

`wait:false` 的 `ask`（**MCP 工具 `dsh_ask` 的默认行为**）返回的是一张**句柄**：

```jsonc
{
  "sessionId": "session-…",
  "requestId": "rpc-…",
  "status": "running",
  "turn": null,                   // 句柄里不带轮次号
  "text": "",
  "accepted": true,
  "mode": "queue",                // 这一句是以 queue 还是 steer 投递的
  "created": false,
  "cwd": "…",
  "permissionPreset": "read-only"
}
```

读结果的几条约定：

- `status` 一律来自该轮自己的 `turn/end` 原因，**不会**把被取消的轮次报成 `completed`。
- `turn/end` 若**没带 `reason`**，`status` 报 `unknown`、`reason` 给出 `{kind:"unknown", message:"the Host ended the turn without a reason; treat this outcome as unverified"}`。类型上 `reason` 必填，但那是 TypeScript 联合类型，运行时并不校验——没法描述的结局按成功报是最难查的一种错。
- `timeout` 表示等待超时，**不会**取消该轮；这类结果没有 `turn/end` 可引用，`reason` 由桥给出 `{kind:"timeout", message:"…it keeps running"}`。
- `partial: true` 只出现在 `status:"unknown"` 时：事件流没等到 `turn/end` 就结束了，`text` 是半截。
- `cwd` 只在 `created:true` 时回填。
- `waiting-approval` 只在 `approvals.mode=delegate` 且这一轮正等你回答时出现，见[权限与升权](#权限与升权)。

`tools` 的 `output` 单条截断 4000 字、整轮共享 20000 字预算，超出会写 `… (omitted, N chars: this turn's tool-output budget of 20000 is spent)`。

### `since` 只回增量

不传是整轮；传了就只返回 `seq > since` 的事件，`text` 随之只含这段。**`status` / `turn` / `tools` / `usage` / `sandbox` 仍描述整轮**，`cursor` 照常前进。轮询进度用 `since: <上次的 cursor>`，不要重投。

### 分片等待与截止

- **单次 HTTP 请求活不过五分钟**：Node 内建 `fetch` 的 `headersTimeout` 是 300 秒，实测 303.9 秒报 `fetch failed`。所以桥把一次等待切成 `maxWaitSliceMs`（默认 **120000**，上限 240000）返回 `status:"timeout"` 并附 `sliceMs` / `requestedMs`，由调用方续等。**CLI 与 MCP 工具已经替你循环**，直接传总预算即可；自己写客户端要么分片，要么别请求超过 300 秒的等待。
- `waitedMs` 是墙钟：尾片不足 1 秒时会抬到 1000 ms 下限，所以可能比预算多出最多 1 秒；`slices` 是实际请求次数。
- **答案由我们的截止写出，不由宿主决定**：每次读事件都与本次运行的截止赛跑，末尾清理（向宿主注销事件流）也只在 1 秒内等待——宿主卡住时会拖慢我们一次，但拖不住答案。
- **"还没好"不是失败**：`status:"timeout"` 只说明这一片到期，轮次仍在 Harness 里跑。重投等于重新提问，会多开会话、重复副作用。要进度用 `wait` / `history`。
- **轮次归属**：投递 prompt 后，本插件从事件流里找自己那条 `user/message`（`source.rpcId` 等于本次 `requestId`），以它落在哪一轮为准。因此**同一会话里有别人插话时，不会把别人的回答当成你的**——那一轮的 `turn/end` 会被跳过，继续等自己那一轮。

## 工作区、模型、推理等级

这三个都是 DSH 自己的概念，桥只做转发，不新造开关。

**位置（工作区 / 目录）只在创建会话时决定。** `workspaceId` 走 `workspace.attachSession`，会话因此出现在 GUI 侧栏的对应工作区下；`cwd` 只设置目录、不挂工作区。二者互斥，同时给会被拒绝（`-32602`）。复用已有会话时再传位置参数同样被拒绝——要换位置就新建。`agentPreset` 同理，只在创建时生效。

CLI 和 MCP 都不在客户端预先过滤这些参数：给了就转发，由桥给出统一拒绝理由。这样"传了但没生效"不会伪装成"传了并生效"。

```powershell
node bin/dsh-rpc.mjs workspaces                            # 先看有哪些
node bin/dsh-rpc.mjs ask "看下这个项目" --workspace ws-1      # 进去
node bin/dsh-rpc.mjs models | head -40
node bin/dsh-rpc.mjs ask "重新想想" --session session-xxxx --model anthropic/opus-4.6 --effort high
```

**模型名**可写 `provider/model`；只写裸 id 时，桥会去模型目录里查——唯一命中就用，命中多个就报错并列出可消歧的写法，命中零个就让你去看 `dsh.models`。**不会替你猜一个。** `reasoningEffort` 必须和 `model` 同一次请求给出：Host 没有"读回当前模型"的接口。

> [!WARNING]
> **换模型会把选择存成 profile 默认**（Host 自己的行为，和你在 GUI 里换模型一样）。外部 agent 换过去之后，你在 GUI 新开的会话也会用那个模型。

## 权限与升权

**权限预设**是"沙箱模式 + 审批策略"的组合；名字先按 Host 的 catalog 校验，未知名字直接报错并列出可选项。每项带一句 `cost`，因为部署自带的 `description` 往往是空的。

**默认不要传 `permission`，撞到沙箱限制再升一次**：

1. 桥会在那一轮的结果里给出 `sandbox.denied: true` 与 `next`；
2. `next.args` 只带 `session_id`：**换成 `danger-full-access` 重问一次的决定由你来做**，桥不代你决定，也不把那个参数塞进返回值（否则被挡住的 agent 用自己的措辞就能促成升权）；
3. **只升一次**。这一档审批策略是 `never`，升上去之后这一轮不再有任何拦截——它不是"更宽的默认档"，而是"被挡住时的最后一招"，用过之后应在回答里说明。

为什么升权必须由外层来做：DSH 的沙箱会在被拒输出末尾提示"可以带 `sandbox_permissions` 重试"，但桥驱动的会话是无人值守的——`approval: ask` 时没有应答者，请求被归一成 `unavailable`（那不放行）；`approval: never` 时系统提示词直接禁止请求升权。两条路都堵死，只能由调用方换预设重新发问。

升权阶梯是封闭表：`read-only` 可以升到 `workspace-write` 或 `danger-full-access`，而 **`workspace-write` 只能升到 `danger-full-access`**——没有中间档。

```powershell
node bin/dsh-rpc.mjs permissions
node bin/dsh-rpc.mjs ask "跑一下测试" --permission workspace-write
```

### 无人值守会话与升权（`approvals`）

桥创建的会话没有人坐在 GUI 前面。模型一旦带上 `sandbox_permissions` 请求升权，宿主就把这次调用挂起等人回答——**等多久取决于有没有应答者**，而桥创建的子会话没有。现场实测过两次：`approval/asked` 之后一直没有 `approval/decided`，调用方每次都在 120 秒预算上超时。

三档模式：

| 模式 | 行为 |
| --- | --- |
| `off`（默认） | 桥不挂 gate，保持宿主原本的 fail-closed 行为 |
| `deny` | 桥在 `tools/pre-execute` 上前置拒绝"就地升权" |
| `delegate` | 把决定权交给派发任务的调用方 |

**`deny`** 只收紧、不放宽：本桥创建的会话里，带 `sandbox_permissions` 的调用在派发前就被拒，模型立刻收到

```
approvals.mode=deny refused a sandbox escalation to "danger-full-access" for tool "pwsh"; the call was not executed.
```

不升权的调用完全不受影响；不是本进程创建的会话（包括人在 GUI 里看着的）一律放行给它们自己的应答者。被拒次数记在 `/status` 的 `calls.approvals.denied`。

**`delegate`** 把升权请求挂起，调用方用两个方法回答：

| 方法 | 作用 |
| --- | --- |
| `dsh.approvals.pending({ sessionId?, waitMs? })` | 列出待批请求；`waitMs` 让它变成最多 120 秒的长轮询 |
| `dsh.approvals.resolve({ approvalId, decision, note? })` | 回答某一条：`allow-once` 或 `reject` |

要点：

- **轮次停在待批时，调用会立刻返回**：`dsh_ask` / `dsh_wait` 返回 `status: "waiting-approval"` 与 `pendingApproval`，并给出指向 `dsh_approvals_resolve` 的 `next`。否则调用方就卡在"回答自己那个问题"的循环里。
- **没人回答就是拒绝**：`deadlineMs` 到期按拒绝处理，绝不自动放行。
- **放宽只在被批准的那次调用期间成立**：宿主没有"允许一次"的接口，桥手上只有会话级预设这一个杠杆，所以批准后临时切换预设，调用结束（`tools/post-execute`）立刻恢复；另有 5 分钟兜底定时器。下行应答者抛错、结果处理抛错、宿主取消，三种路径都会恢复原状；`dispose()` 在插件卸载时兜底。
- **按会话计次，每会话最多 3 次**：同一会话同时只允许一个升权调用在跑（同 tick 的并发请求只产生一条待批记录），窗口期内其它不升权的调用会被**扣留**到窗口结束，避免搭便车。
- **可请求的目标只有 `workspace-write` 与 `danger-full-access`** 两档，其余不询问直接拒。
- `approvals.mode` 不是 `off` 时，`dsh.sessions.configure` 不能把会话直接改成 `danger-full-access`，也不能改不属于本桥的会话。
- 放行与拒绝分别记在 `/status` 的 `calls.approvals.allowed` / `calls.approvals.denied`。

决策包字段：`approvalId`（随机 UUID，不可枚举）、`sessionId`、`toolName`、`callId`、`escalation`、`argv`（命令或路径的摘要）、`args`（**整包参数**的脱敏 JSON，凭证形状的值被打码，上限 4000 字）、`argsTruncated`、`cwd`、`preset`（会话**当前**的预设，读不到为 null）、`reason`（子代理自述，截断到 500 字）、`untrusted: true`、`createdAt`、`expiresAt`。

**重启之后**：每会话已用的升权次数、本桥拥有的会话、以及"这次放宽还没还回去"的欠账都写在 `$DSH_HOME/dsh-rpc/approvals.json`（0600、`.tmp` 后 rename 的原子替换）。重启不会把额度清零，也不会让闸门对旧会话失声；进程被杀、放宽没来得及收回时，下一次启动会读这份台账把 preset 还回去（还失败只记 warn）。`approvals.mode=off` 时不写这个文件。

> [!NOTE]
> **为什么不用 `ctx.on("approval/request")`**：审批服务经 `scopeTarget(req.agent, req.agent)` 派发，只会走到"该 agent 自己组合里"的应答者。实测在插件上下文和 root 上下文上各注册一次，真实升权时监听器**一次都没被调用**（GUI 面板还在等），而 `tools/pre-execute` 是全局 waterfall，所有 agent 都覆盖得到。

## 配置

通过 `cordis.patch.yml` 的 `config` 配置，全部有默认值：

```yaml
- insert:
    - id: dsh-rpc-bridge
      name: '@punchact/dsh-rpc-agent'
      config:
        token: ''              # 留空则自动生成并落盘
        allowRemote: false     # 允许非 loopback 来源
        defaultCwd: ''         # ask 未给 cwd 时用这个，再回落到进程 cwd
        defaultAgentPreset: '' # 新建会话的默认 preset
        defaultTimeoutMs: 600000
        maxWaitSliceMs: 120000 # 单次响应等待时长
        historyBudgetMs: 30000 # 一次 history 快照最多等多久
        maxBodyBytes: 1048576
        maxSessions: 200       # 同时进行的等待上限
        approvals:
          mode: off            # off（默认）| deny | delegate
          deadlineMs: 60000    # delegate：等调用方回答的时长，超时视为拒绝
```

其余键：`enabled`、`tokenFile`（自定义 token 路径）、`path`（默认 `/dsh-rpc`）、`logRequests`。环境变量 `DSH_RPC_TOKEN` 可覆盖 token（优先级高于文件），适合 CI 或不想落盘的场景。

## 安全模型

**一句话：本插件的 bearer token 等价于"在这台机器上让 DSH 替你执行动作"的权限。**

拿到 token 的进程可以新建会话、投递 prompt，于是 DSH 会用**它自己的**工具去读文件、写文件、跑命令、访问网络——受 DSH 自己的沙箱与审批策略约束，但不受本插件约束。本插件只做两件事：把请求转给 Host、把结果转回来；它不额外放宽任何权限，也不替你审阅内容。

| 面 | 现状 |
| --- | --- |
| 传输 | loopback + Bearer token；默认只接受 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`，其它 403 |
| token 存储 | `%USERPROFILE%\.dsh\dsh-rpc\token`，首次启动生成 32 字节随机值，0600 |
| token 比较 | SHA-256 + 定时安全比较，不按字节提前返回 |
| 免鉴权端点 | `GET /health`，只回 `{ok, plugin, version, protocol, authenticated}` |
| 请求体上限 | 1 MiB（可配），超限 413，不会无限读入内存 |
| 来源校验 | 按 socket 的 `remoteAddress`，不看 `X-Forwarded-For` |

**没有做的事**（有意为之）：不加密传输（只服务 loopback、不监听对外网卡）、不做速率限制、不做请求签名、默认不记录 prompt 内容（`logRequests` 显式打开才记日志头部）。

**如果要暴露到局域网**：`allowRemote: true` 只是关掉 loopback 白名单，**不会**增加任何认证强度。那种部署应放在 TLS 终止代理后面并另配访问控制。

**共享机器**：token 文件就是凭据。不要抄进 shell 历史、CI 明文变量或聊天记录；怀疑泄漏就删掉该文件并重载插件——会重新生成，旧 token 立即失效。

## 端口与连接稳定性

DSH 的 Web 服务端口由启动器决定，桌面端交给系统分配，所以**重启后会变**。本插件不固定端口。

**为什么不在 patch 里写死**：`dsh-web-app` 的 webserver 行用 `!!js` 取 `ctx.webStartup.port ?? 3080`；而 `cordis.patch.yml` 的覆写是**整行 config 替换**，写死就要把 `host` / `tls` / `compression` 等键全部重述，官方升级引入新键时会静默丢掉。端口被占时 DSH 还会起不来。

**端点由插件发布**：每次激活调用 `ctx.webServer.getOrigin()` 拿真实地址写进 `endpoint.json`；客户端（CLI / MCP / `lib/client.mjs`）**每次调用都重新读**，不缓存。

```jsonc
{
  "url": "http://127.0.0.1:3820/dsh-rpc",
  "origin": "http://127.0.0.1:3820",
  "path": "/dsh-rpc",
  "version": "0.7.7",                        // 正在运行的那份插件自报的版本
  "plugin": "dsh-rpc-agent",
  "pid": 12345,                              // 写这个文件的 Host 进程
  "startedAt": "2026-11-05T01:05:58.000Z",   // 该进程的启动时刻
  "updatedAt": "2026-11-05T01:06:31.924Z"    // 本次写入时刻
}
```

`pid` 与 `startedAt` 是给客户端判断"Harness 重启过没有"用的：两者都没变却连不上，说明不是端口漂移。

**重启窗口内只重试一种错**：客户端仅对 `ECONNREFUSED`（TCP 被拒、请求没发出去）重读端点重试一次；`ECONNRESET` / `EPIPE` / 超时**不重试**，因为字节可能已被对方收下，重发有重复投递 prompt 的风险。显式 `--url` 或 `DSH_RPC_URL` 也不重试。

**重启后串脚本**：

```powershell
node bin/dsh-rpc.mjs health --wait 15000; if ($?) { node bin/dsh-rpc.mjs ask "接着干" --session session-xxxx }
```

`--wait` 每 250 ms 重读端点并探活，就绪返回 0（打印耗时），超时返回 3。

**仍可能失败的情形**：Harness 启动中插件尚未激活（`endpoint.json` 还是上一次的地址）；同时跑多个实例（单文件，后写覆盖先写）。这两种请用 `--url` 显式指定。

**调用方断开之后**：非流式请求在 socket 关闭时会中止这次调用——事件迭代停下、运行槽位释放，但**那一轮不会取消**，它仍在 Host 里继续跑，之后还能用 `wait` 收（GUI 里也看得到）。这是 abort 与 cancel 的区别。

**被中止的调用怎么记账**：记在 `/status` 的 `calls.outcomes`，不是 `errors`——`timeouts` 是"等到预算用完"，`cancelledByClient` 是"调用方先走了"。

## 在 GUI 里跟进

CLI 的 stdout 只在执行它的终端里——那是**调用方进程**的输出。但被驱动的那一轮**是 Harness 里的真会话**，所以它同时出现在 GUI：

| 层 | 在哪看得到 |
| --- | --- |
| CLI 进程的 stdout / stderr / 退出码 | 只在执行它的终端 |
| 该轮的会话与完整对话 | GUI 侧栏的会话列表；点开可看 transcript、工具调用、token 用量 |

能这样是因为插件走 Host 的 `sessionController`（而不是拿一个裸 agent）：会话日志、标题生成、`running` 状态都来自同一份存储。

三个实践要点：

1. **总是带 `--cwd`**。不带时 Host 用进程工作目录（通常是 DSH 自己的 profile 目录），这样的会话在侧栏里不容易认出属于哪个项目。
2. **留住返回的 `sessionId`**。后续 `wait` / `history` / 续聊 / 在 GUI 里接手都靠它。
3. **GUI 不会主动弹窗**。会话只是进了列表，需要你点开。

**审批仍由 GUI 或你的策略决定**：若那一轮触发需要人工批准的工具调用，它会挂在 Host 侧等待；没人打开会话时会一直等到 `timeoutMs` 用完——此时 `ask` 返回 `status:"timeout"`，且**不会**取消该轮（可在 GUI 里继续，或 `dsh.sessions.cancel`）。

## 状态面板

装好之后，设置窗口左侧多出一项 **「RPC 桥接」**（`设置 → RPC 桥接`）。它回答的是"桥现在活着吗、刚才谁调过什么"：

| 区块 | 内容 |
| --- | --- |
| 状态灯 | 在线 / 连不上，版本号，最近一次刷新时间（每 2 秒拉一次） |
| 运行信息 | 端点、协议版本、凭据来源、已服务时长、`pid`、Node 版本、是否允许远程、调用总数与失败数 |
| 正在跑的轮次 | 每个活动的 `ask`/`wait`：运行 ID 前 8 位、是否有会话、是否带提问、已跑多久 |
| 最近 12 次调用 | 时间、方法名、耗时、成功/失败与错误码 |
| 方法用量 | 按方法累计的次数与错误次数，以及 `timeouts` / `cancelledByClient` 两个非失败结局 |
| 怎么接 | 两条可直接复制的命令（MCP 注册、CLI 试一次） |
| 配置片段 | 按当前生效值生成的 `cordis.patch.yml` 行，一键复制 |

它读的是 **`GET /dsh-rpc/status`**：与 `/health` 同一信任边界——**只接受 loopback、不要 token**，因为浏览器里的页面拿不到 `endpoint.json` 里的 token。作为交换，这个端点必须"什么也不说"：

- 不含 token、不含 `sessionId`（活动轮次只给运行 ID 前 8 位与"是否有会话"）；
- 不含任何调用参数——不记 prompt 正文、不记工具参数。调用记账只存**方法名、耗时、结果码**。

页面的数据全部来自这条只读接口，不写任何东西。想让面板消失就停用插件；`/status` 与页面一起下线。

> 端口变了不用管：页面请求的是固定路径 `/dsh-rpc/status`（插件在 `path` 被改时会额外保留这个别名），而状态数据里的 `origin` 永远是当前真实的监听地址。

## 已知边界

- **同一会话只允许一个「提问型」运行**：两个 `ask` 并发时第二个默认返回 `-32004`；加 `queue: true` 则排队（在它自己的 `timeoutMs` 内，超时 `-32005`），排队期间 `ping` / 状态页能看到 `state: "queued"`。这只约束本插件——GUI 或别的 agent 仍可插话；轮次归属靠 `rpcId` 认领，不会把别人的回答当成你的，代价是要等它跑完才轮到你。`wait` 不受限。
- **`wait` 只看得见快照窗口**：靠 `follow` 首帧快照判断"当前/最后一轮"，窗口上限 500 条事件。极长会话若快照已截断到目标轮次之前，可能把状态报成 `completed`；要精确值就带 `sessionId` 调 `history` 复核。
- **批量请求串行执行**：一个 HTTP batch 里的多条 JSON-RPC **按顺序**执行，一条慢 `ask` 会挡住同批后续请求。要并发请用多个连接。
- **不复制审批策略**：Harness 侧仍按自己的审批与沙箱策略执行；需要人工批准的工具可能让该轮长时间挂起。`permissionPreset` 下发的是该会话默认预设，不是放行。
- **位置只在创建时决定**：`workspaceId` / `cwd` 对已有会话无效，桥直接拒绝而不是默默忽略。换位置 = 新建会话。
- **换模型会改 profile 默认**：`selectModel` 是 Host 的模型切换入口，它会把选择存成 profile 默认。
- **权限预设依赖可选服务**：本部署若没有 `permissionPresets` 服务，传 `permissionPreset` 会得到 `-32000` 并说明原因。
- **工作区只增不删**：桥只暴露 `workspaces.list` / `workspaces.create`；删除与改名请用 GUI。
- **只转发 Host 允许的会话**：`sessions.list` 与 `history` 经 Host 的 `remoteAccess` 过滤。
- **正文截断**：单轮保留事件上限 4000 条；超长会话的 `text` 仍完整（来自 `assistant/message`），但 `tools` 列表可能被截断。
- **token 泄漏面**：token 与 DSH 其它凭据同级落盘。**本桥创建的子会话读得到它**——子代理与调用方是同一个系统用户，`workspace-write` 沙箱也允许读用户目录（2026-11-06 实测：子会话读到 token 后能直接 `POST /dsh-rpc` 调 `dsh.ping`）。所以 `approvals.delegate` 的批准权防的是**误操作与提示注入**，不防"同机同用户的进程自己想升权"。
- **审批闸门只拦一条路**：`deny` / `delegate` 拦的是**工具参数里的 `sandbox_permissions`**。通过 `configure` 改预设或新建会话时指定 `permissionPreset` 走的是另一条路——前者在 `approvals.mode` 非 `off` 时被禁止，但**新建**会话时由调用方自己选的预设不受闸门约束（那是派发方的决定，不是子代理的）。
- **未声明 `Config` schema**：插件用手写校验读 row 的 `config`，而不是导出 `Config`（保持零依赖）。代价是 `cordis_inspect_query` 里这行显示 `status: absent`，也没有可视化表单；配置项见[配置](#配置)。

## 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| `dsh-rpc: 401` | token 不匹配。删掉 `%USERPROFILE%\.dsh\dsh-rpc\token` 后重载插件即重新生成 |
| `403` | 来源不是 loopback；确认没走代理，或打开 `allowRemote` |
| `-32004 … already has a bridge run waiting for its turn` | 同一会话已有 `ask`/`prompt` 在等轮次；换一个会话，或等它结束（`wait` 可并行观察） |
| 退出码 `3`（连不上） | Harness 没在跑，或插件的行被禁用；先 `node bin/dsh-rpc.mjs health` 探活 |
| 改了源码但行为没变 | 宿主缓存了模块：`set_plugin` 关一次再开 |
| 改了源码但行为没变（npm 装的） | npm 路线装的是拷贝，与工作区无关；要边改边试请用本地目录安装 |
| 安装时报冷静期 / 版本取不到 | 刚发布的版本可能还在 `minimumReleaseAge` 窗口内；钉一个已过窗口的版本，或按[安装与更新](#安装与更新)放行 |
| `Cannot read properties of undefined (reading 'throwIfAborted')` | 旧版本把 Host 的 `prompt`/`list` 用 `undefined` 调用；已修 |
| 插件行状态 `absent` | 正常：插件不导出 `Config` schema，`cordis_inspect_query` 里没有 config 契约 |

## 开发与验证

```powershell
cd dsh-rpc-plugin
npm test                       # 一次跑完十段，共 183 例；不需要 Harness，也不需要 npm install
node test/host.test.mjs        # 1 例：真宿主集成（需先 npm ci）
node test/e2e.mjs --cwd .      # 14 例：端到端，打真实 Harness
node test/edge.mjs             # 24 例：协议/边界对抗，打真实 Harness
```

<details>
<summary>十个套件各自钉住什么</summary>

| 套件 | 例 | 钉住 |
| --- | --- | --- |
| `methods` | 76 | 轮次归属、steer、超时、abort 原因、history、cancel、参数契约 |
| `mcp-format` | 19 | 结果渲染：`note:` / `next:` / 截断 / 去重 / 待批 |
| `registry` | 8 | 粘性会话表读写、损坏降级、轮换 |
| `pending` | 36 | 待批存储、长轮询、取消收回、额度预占、事务边界 |
| `approvals` | 11 | 配置校验、gate 的 deny/delegate 分支、所有权、白名单 |
| `approval-state` | 8 | 台账跨重启、按字段合并、TTL、孤儿收回 |
| `wait` | 6 | 分片等待（真 HTTP 桩） |
| `abort` | 7 | 中止链路（真 socket / 进程内登记表） |
| `client` | 6 | 客户端重试与报错 |
| `status` | 6 | `/status` 载荷与路由挂载契约 |

</details>

`npm test` 按固定顺序跑这十段；`npm run test:host` 跑真宿主集成；`npm run test:e2e` / `npm run test:edge` 要活的 Harness。

> [!TIP]
> **别用 `node --test`**：它会为每个文件 fork 子进程，在 DSH 沙箱里被 `spawn EPERM` 挡住。

几个值得单独说的：

- **真宿主集成**不用假 `webServer`：`new Context()` + `ctx.plugin(WebServer, {host:'127.0.0.1', port: 0})` 起真监听，再 `apply()`，然后真发 HTTP 断言 `/health` 200、无 token 的 RPC 401、`/status` 的 `origin` 与真实监听一致，**最后跑插件自己的 disposer 并断言 `/health` 与 `/status` 都变 404**。这是唯一能抓住"上一代路由残留导致重载失败"这一真实事故的测试。
- **端到端**走的是与外部 agent 完全相同的 `lib/client.mjs`，因此跑绿即证明 plugin → Host `sessionController` → HTTP → JSON-RPC → 调用方整条链路成立。
- **边界**检查协议层：batch、通知、id 形态、鉴权头、超大 body（应得真正的 413 而不是断连）、参数注入防护、超时钳制、并发 ask、`limit` 语义。
- **端口漂移**（手工）：把 `endpoint.json` 的 url 改成死端口再跑 `dsh-rpc ping`，应得退出码 3 与含 `nothing is listening`、`pid`、`health --wait` 的可读报错。

上次实跑：单元 183/183（CI）、宿主 1/1（2026-11-06）；本机同一提交 182 通过 + 1 例因沙箱禁止子进程（`spawn EPERM`）失败；端到端 14/14、边界 24/24（2026-11-05）。

## 许可证

[MIT](./LICENSE) © 2026 Punchact。设计取舍见 [docs/design.md](./docs/design.md)，安全策略见 [SECURITY.md](./SECURITY.md)，发版流程见 [docs/release.md](./docs/release.md)。
