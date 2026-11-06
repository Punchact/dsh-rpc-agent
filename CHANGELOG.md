# 变更记录

本文件记录每个对外版本改了什么。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

只有**对外可见的行为变化**才值得单独一行：新方法、语义变化、修掉的 bug、会影响使用者的坑。
内部重构与措辞调整不记。

## [未发布]

暂无。

## [0.5.2] - 2026-11-06

0.5.1 尚未发布到 npm。这一版修的是"等不到"：**单次 HTTP 请求活不过五分钟**，所以等待改成分片循环。

- **等待不再被传输层掐死**：桥把单次等待切成 `maxWaitSliceMs`（默认 240000，配置项），到点返回 `status:"timeout"` 并附 `sliceMs` / `requestedMs` 说明"这次只被允许等这么久"；CLI 与 MCP 的 `wait` / `ask` 自动续等，直到轮次结束或预算用完。此前 `wait --timeout 400000` 在 303.9 秒报 `fetch failed`——因为 Node 内建 fetch 的 `headersTimeout` 是 300 秒，与服务端无关。
- `dsh.discover` 现在返回 `config`（含 `defaultTimeoutMs` / `maxWaitSliceMs`），MCP 的提示文案与默认预算据此生成，不再写死 `600000`。
- CLI `call` 的 `--timeout` 对本子命令生效，且 `call dsh.sessions.wait` 走分片等待（此前固定 120 秒）。
- CLI `wait` 新增 `--since <cursor>`，只取该游标之后的增量。
- 渲染：消息里已经说过的字段不再重复成 `data: {…}`；超过 2000 字的工具正文截断并标注截断量；空闲会话不再显示 `turn 0`。

## [0.5.1] - 2026-11-06

0.5.0 尚未发布到 npm。这一版修掉实地冒烟发现的四处输出约定问题、一处文档口径，以及一处把 `` --model `` 吞掉的静默丢参。

- 句柄的元信息行不再打印 `turn ?`——句柄本来就没有轮次号，占位符会被当成可用的数据。
- `completed` 不再输出 `reason: {"kind":"completed"}`，它与 `outcome: completed` 重复；需要解释的结局才带 `reason`。
- 工具报错不再把整个 `data` 原样 `JSON.stringify` 进正文（读起来像堆栈、还把提示压到底部），只补消息里没说的字段。
- `dsh_ask` 的 `reuse` / `mode` / `wait` 在 schema 里声明了 `default`，外部客户端读 schema 就能看到默认值。
- `dsh.sessions.prompt` 现在真的应用 `model` / `reasoningEffort` / `permissionPreset`；此前 CLI 的 `prompt --model` 会被静默丢弃，会话悄悄跑在 profile 默认模型上。`cwd` / `workspaceId` / `agentPreset` 这类创建期参数改为显式 `-32602` 拒绝，而不是忽略。
- README 如实说明：本机宿主 `list()` 不带创建时间，`createdAt` 为 `null`、`sort:"createdAt"` 退化为宿主原序。

## [0.5.0] - 2026-11-06

这一个版本故意破坏两处默认值，换掉"每次调用都新开一个会话、每次都阻塞到被自己的超时砍断"的老形态。

### 破坏性变更

- **MCP 工具 `dsh_ask` 的 `wait` 默认值改成 `false`**：立刻返回句柄，结果用 `dsh_wait` 收。
  要走老行为就显式传 `wait: true`。**RPC 方法 `dsh.sessions.ask` 仍默认 `true`**——协议方法不跨小版本改形状。
- **`dsh_ask` 的结果第一行固定是 `session <id>`**，正文与 `— outcome: …` 元信息在后；元信息里不再重复会话 id。
  以前 id 只出现在尾巴上，被调用方超时截断就丢了，下一次只能新开会话。

### 新增

- **粘性会话**：不带 `session_id` 时，`dsh_ask` 按 `${客户端名}::${project ?? cwd}` 查
  `~/.dsh/dsh-rpc/sessions.json`，命中且会话仍存在、非空就复用，否则新建并回写。新参数 `project`、
  `reuse`（`auto`/`never`/`latest`）、`namespace`；结果带 `reused` / `rotated` / `previousSessionId`。
  同一键累计 200 次 `ask` 后自动轮换。
- **`mode` 三态**：`turn`（默认，会话正忙则 `-32004` 并附 `data.next`）、`steer`（插进当前轮）、
  `queue`（等当前轮结束）。`turn` 是桥自己的判据，宿主只认 `steer` / `queue`；其它值返回 `-32602`。
- **`dsh_sessions` 支持 `cwd` 前缀过滤与 `sort`**（`updatedAt` 默认 / `createdAt`），会话项新增 `createdAt`
  （宿主的 `list()` 本身不提供创建时间，该字段目前恒为 `null`，按它排序等于保持宿主原序）。

## [0.4.5] - 2026-11-06

### 新增

- `dsh_ask`（及 `dsh.sessions.ask`）新增 `wait`，默认 `true`。`wait:false` 立刻返回句柄
  `{sessionId, requestId, mode, status:"running", turn:null, text:"", accepted:true}`，任务在 DSH 里继续跑，
  用 `dsh_wait` 收结果——给"调用方自己的工具超时短于这轮任务"的场景用。
- `dsh_wait`（及 `dsh.sessions.wait`）新增 `since` 游标：只返回该序号之后的事件（`text` 随之只含这段），
  `status`/`turn`/`tools`/`usage`/`sandbox` 仍描述整轮（增量只收窄正文），`cursor` 照常前进。轮询进度用它，不要重投。

### 修复

- **"还没好"不再被渲染成工具错误。** 之前 MCP 工具结果按 `status !== "completed"` 判 `isError`，
  而 `status` 是 Host 的 `reason.kind` 原样透出；于是一次 `timeout` 就变成"工具失败"，调用方据此重投，
  重投等于重新提问。现在 `isError` 只在调用本身失败时为真。
- 工具结果正文固定带 `outcome:` 行；**每一种结束原因都带一行 `note:`（人话解释）与一行 `next:`（下一步）**，
  只有 `completed` 两者都没有。
- 失败的调用也带 `next:`：按 JSON-RPC 码给出下一步（`-32003` 查会话、`-32004` 跟随或排队、
  `-32005` 放弃等槽、`-32006` 取消）。
- `wait` 在"没有可等的轮次、直接返回上一轮"这条路径上补上了 `since` 收窄（原先只有等待路径支持）。
- `queue: true` 与 `wait: false` 相矛盾时直接返回 `-32602`，不再悄悄忽略其中一个。
- `timeout` 结果不再留空的 `reason`：等待超时时那一轮没有 `turn/end` 可引用，现在由桥填
  `{kind:"timeout", message:"… it keeps running"}`，调用方不必再从"没有原因"里猜发生了什么。
- **没有 `reason` 的 `turn/end` 不再报成功。** `TurnEndReason` 是 TypeScript 联合类型，跨进程传的是普通
  JSON，运行时不校验；宿主少写一个字段，旧代码就落到 `endEvent ? "completed" : "unknown"`，把一轮**没人描述过**
  的结局报成 `completed`。现在这种情形 `status` 为 `unknown`、`reason` 为
  `{kind:"unknown", message:"the Host ended the turn without a reason; treat this outcome as unverified"}`。
- **六种"非完成"结局不再零提示。** `aborted`（并区分 `user` / `parent` / `hook{reason}` / `disposed` / `legacy`）、
  `blocked`、`error`（带 `LlmFailure` 的 `code` 与 `message`，并说明"这不是工具失败"）、`max-tokens`、
  `interrupted`、`forked`、`refusal` 现在各有一句归属清楚的解释与下一步；宿主新增的、本插件不认识的 `kind`
  降级为"unverified，先查 `dsh_sessions()`"，绝不冒充 `completed`。
- `partial` 的提示不再断言"仍在运行"：它只表示流里没有 `turn/end`，宿主可能已经随之消失，因此先要求
  `dsh_sessions()` 确认再决定 `dsh_wait` 还是重投。

## [0.4.4] - 2026-11-05

### 修复

- 发布流水线在**没有配置 `NPM_TOKEN`** 时，`setup-node` 的 `registry-url` 会写下一行
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`；secret 不存在时它展开成空令牌，npm 于是认定
  "凭证存在但无效"，直接 `ENEEDAUTH`，**根本不会去试 OIDC**。现在不再用 `registry-url`，
  `~/.npmrc` 只在确实有令牌时由发布步骤自己写。
- 发布任务多一步诊断，打印 node/npm 版本与 OIDC 端点是否可用，免得下次再靠猜。

### 说明

- 运行时没有任何改动。这一版的目的是让 `latest` 由 OIDC 发布出来（带 provenance）。

## [0.4.3] - 2026-11-05

### 变更

- 文档里不再出现早期开发用过的包名；仓库历史一并重写，对外行为没有任何变化。
- 测试夹具的临时目录改用中性的 `/home/dev/work`。

### 说明

- 这一版只动文档与测试夹具，没有运行时改动。之所以单独发版，是为了让 npm 上的
  `latest` 指向不含该字样的产物。

## [0.4.2] - 2026-11-05

### 变更

- 发布流水线改为两条凭证并存：Trusted Publishing（OIDC）优先、`NPM_TOKEN` 兜底。npm CLI 自己先试
  OIDC，失败再回落到令牌，所以走通 OIDC 时仓库里没有任何长期密钥参与。
- 两种凭证都没有时只跑 `npm publish --dry-run` 并把原因打出来，而不是让一次 Release 因为没配 secret 失败。
- 真发布失败时打印四条 `::error::`，指向三个最可能的原因：信任关系是否允许 `npm publish`、
  工作流文件名是否与它一字不差、要不要补 `NPM_TOKEN`。

### 修复

- 不再写 `--provenance` 参数：OIDC + 公开仓库 + 公开包时 npm 会自动生成，私有仓库加这个参数会被直接拒绝。

## [0.4.1] - 2026-11-05

首次发布到 npm。

### 新增

- `scripts/check-package.mjs`：以 `npm pack` 给出的**真实清单**为基准，断言必需文件齐备、`test/`
  `scripts/` `node_modules/` 没混进来、`main`/`exports`/`bin`/`icon`/`dsh.bundle.patch` 指向的文件都在包里，
  并顺着每个相对 `import` 走一遍；同时断言 `private` 不存在、`publishConfig.access` 是 `public`。
- `.github/workflows/release.yml`：由 GitHub Release 触发发布，先跑版本一致性、三套测试与打包检查。
- `docs/release.md`：发版手册，含凭证准备、发版步骤、手动兜底与不可逆事项。

### 变更

- `package.json` 去掉 `"private"`，加 `publishConfig.access: public`，`files` 不再包含 `test/`。
- `prepublishOnly` 串联 `check:version`、单元套件与 `check:package`：检查不过就上传不了。

### 修复

- 记录一条实测结论：`npm publish --dry-run` **不**校验 `private`，带着它 dry-run 仍然成功，
  真正的拒绝发生在正式发布时——所以这件事只能靠断言守。

## [0.4.0] - 2026-11-05

### 变更

- 包名 `@punchact/dsh-rpc` → `@punchact/dsh-rpc-agent`。`PLUGIN_NAME`、`cordis.patch.yml` 的插件行、
  浏览器模块 id、面板里可复制的配置片段同步改名。
- GitHub 仓库名 `dsh-rpc` → `dsh-rpc-agent`，`repository`/`homepage`/`bugs` 随之更新。

### 说明

这些**运行时契约没有改**，所以升级不需要动任何既有配置：命令行 `dsh-rpc` / `dsh-rpc-mcp`、
端点路径 `/dsh-rpc`、状态目录 `~/.dsh/dsh-rpc`（内含已配对的 token）、`DSH_RPC_*` 环境变量。

## [0.3.0] - 2026-11-05

### 新增

- **工作区**：`dsh.sessions.create` / `dsh.sessions.ask` 支持 `workspaceId`（与 `cwd` 互斥），
  用工作区创建的会话会出现在 GUI 的对应工作区下。配套 `dsh.workspaces.list` 与 `dsh.workspaces.create`。
- **模型与推理等级**：`model` 接受 `provider/model` 或裸 id（多个 provider 提供同名模型时报错要求写全），
  `reasoningEffort` 必须与 `model` 在同一个请求里。
- **权限预设**：`permissionPreset` 先按 `catalog()` 的白名单校验，再作用于会话；配套 `dsh.permissions.catalog`。
- **会话选项后置**：`dsh.sessions.configure` 可在不新建会话的前提下调整上面三项。
- **同会话排队**：`queue: true` 让第二次提问型运行排队等前一次落定，而不是直接 `-32004`；
  `ping` 与 `/status` 会显示 `state: "queued"`。
- 真宿主集成测试 `test/host.test.mjs`：用真实的 `WebServer` 起进程内宿主，断言 `/health`、401、`/status`
  与**卸载后路由变 404**（这条正是为了抓住"重载残留旧路由"那类事故）。
- 设置页面板新增「配置片段」：按此刻生效的配置生成可直接粘贴的 `cordis.patch.yml` 片段，令牌永不出现在其中。

### 变更

- `dsh.sessions.create` 明确拒绝 `sessionId`：id 由宿主分配，传了就报 `-32602`，
  不再"接受一个 id、悄悄返回另一个"。
- `dsh.sessions.ask` 复用会话时若给 `workspaceId` / `cwd` 改为报错——位置只在创建时决定。
- 单元套件增加套件级 keepalive：产品侧的截止定时器一律 `unref()`（一次桥运行不该让宿主进程保活），
  于是 CI 上等待超时的用例会因为事件循环提前排空而被"取消"。

### 修复

- 两个排队者不会在同一次释放上同时占住会话（检查与占位合并为一次原子操作）。
- `applyPermissionPreset` 会等待异步的 `catalog()`，白名单此前形同虚设。
- 超时或中止后 `runs` / `prompting` 不再泄漏，`ping.activeRuns` 归零。
- 权限预设、模型相关的宿主错误码正确映射为 `-32602` / `-32603`，不再一律落到 `-32000`。

## [0.2.0] - 2026-11-05

### 新增

- 设置页「RPC 桥接」状态面板：状态灯与版本、端点与运行时信息、正在跑的轮次、最近 12 次调用、
  方法用量、以及两条可复制命令；每 2 秒刷新。
- `GET /dsh-rpc/status`：仅 loopback、免 token，但只返回聚合数据——**不含** prompt 正文与 sessionId，
  也不含令牌。
- `lib/stats.mjs`：只记方法名、耗时、结果码的环形缓冲，供状态面板使用。

### 修复

- 路由以「寄生单元」注册：宿主每次重载都会重新 `import` 模块，模块级 Map 会丢掉上一代的记录，
  现在新一代接管同一个 path 而不是撞上"重复路由"；挂载整段失败时原子回滚，不再半挂载。

## [0.1.0] - 2026-11-05

首个版本。

### 新增

- JSON-RPC 2.0 端点 `/dsh-rpc`、NDJSON 流式端点 `/dsh-rpc/stream`、免鉴权的 `/dsh-rpc/health`。
- 10 个方法：`discover`、`ping`、`models`、`sessions.list/create/ask/prompt/wait/cancel/history`。
- CLI（`dsh-rpc`）与 MCP stdio 服务（`dsh-rpc-mcp`，5 个工具），以及一个可 `import` 的客户端库。
- 鉴权：32 字节随机令牌，持久化在 `~/.dsh/dsh-rpc/token`（0600），SHA-256 + 定时安全比较；
  只接受 loopback 来源。
- 端点自发布：插件把 `{url, origin, path, version, pid, startedAt}` 写进 `~/.dsh/dsh-rpc/endpoint.json`，
  客户端每次调用现读，因此端口随宿主重启漂移也不需要重新配置。
- 轮次归属用请求标识（`rpcId`）认领，而不是靠轮次编号猜测——同一会话被别的来源插话时不会串答案。
- 三套测试：单元、对抗性边界、端到端；双语文档与设计说明。
