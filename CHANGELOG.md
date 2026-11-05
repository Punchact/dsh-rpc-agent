# 变更记录

本文件记录每个对外版本改了什么。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

只有**对外可见的行为变化**才值得单独一行：新方法、语义变化、修掉的 bug、会影响使用者的坑。
内部重构与措辞调整不记。

## [未发布]

暂无。

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
