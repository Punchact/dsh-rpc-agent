# 变更记录

## [0.9.5] - 未发布

- **门禁脚本也迁到 TypeScript（9 个文件 / 1,458 行）**：`scripts/` 下 `build`、`check-dist-fidelity`、`check-docs`、`check-entry-parity`、`check-package`、`check-release-path`、`check-surface`、`check-test-targets`、`count-cases` 从 `.mjs` 改成 `.ts`，由 Node 22.19+/24 的原生类型剥离直接运行（`node scripts/build.ts`），不需要额外构建步骤，也**不进发布包**。此前这 1,458 行既不在 `tsconfig.json` 的 `include` 里、也没有任何类型检查覆盖——"发布面 100% TypeScript"之外的一块盲区。新增 `tsconfig.scripts.json`（`noEmit`、`allowImportingTsExtensions`、继承 `strict`），`npm run check:types` 现在同时检查 `client.js` 与 `scripts/`，strict 报错从 **93 条收敛到 0**；`package.json`、两个 workflow、`docs/` 里的脚本路径同步更新，CI 的语法检查 glob 改为 `scripts/*.ts`（`node --check` 对 `.ts` 可用，本机与 CI 实测）。九处脚本的运行输出文案逐字未变（`docs ok …`、`surface ok …`、`check-release-path: ok …`、`build: 编译 41 个 .mts …` 等），`npm run verify` 与 `test:host` 均 exit 0。

> 本版验证：校验 34 个 RPC 方法、MCP 11（默认）+ 11（	asksEnabled: true 时共 22）个工具；全链 47 个测试文件、434 例，本机 434/434 通过。

## [0.9.4] - 2026-11-20

> 本版主题：全仓迁到 TypeScript，并把发布链路改成“发布的就是验过的那一份”。发布面 100% TypeScript（41 个 `.mts` 编译，仅 `client.js` 按决策 0.9.4-a 原位 `@ts-check`）；包内所有 `.mjs` 均为产物，不含源码。

> 本版验证：校验 34 个 RPC 方法、MCP 11（默认）+ 11（`tasksEnabled: true` 时共 22）个工具；全链 47 个测试文件、434 例，本机 434/434 通过。

- **质量复核（Codex，`gpt-6.2-sol`）挖出的三条行为回归 + 发布物绑定**：`bin/` 两个入口的 `IS_MAIN` 拿未解析的 `process.argv[1]` 与已解析的 `import.meta.url` 比较，经 Windows junction（`node_modules/@andy/dsh-rpc` 指向仓库根）调用时被判成“不是入口”而静默 `exit 0`——CLI 一行不输出、MCP 不服务，两者都像“调用方正常结束”；`engine.submit` 把 `requestDigest` 收窄成“字符串或未传”，数字摘要被抹成缺失，`consumePreviewInTx` 的摘要校验整段跳过，一次对不上的提交因此建了单；MCP `tools/call` 把非对象 `arguments`（例如 `[]`）归一成空参数对象，非法输入变成一次带默认值的正常调用。三处统一改成“非法就拒绝”：入口判定两侧都走 `realpathSync`、摘要原样交给校验、`arguments` 非对象直接 `-32602`；回归分别是 `test/bin-entry.test.mjs`（junction 下两个入口）、`test/tasks-preview.test.mjs` 的数字摘要用例、`test/cli-mcp-regressions.test.mjs` 的 `arguments: []` 用例，三条都做过负向控制（把修复改回旧写法，测试必须转红）。发布链路同时从“verify 与 publish 各自构建”改成 **artifact 绑定**：`verify` 用 `npm pack ./dist` 打出 tarball、记 `sha256sum` 并 `upload-artifact`，`publish` 只 `download-artifact` → 校验摘要 → `npm publish "$TARBALL"`，不再重建；`scripts/check-release-path.mjs` 逐条要求“每条 publish 都指向 tarball”“publish 里不许 `npm run build`”“上传/下载 artifact 同名”“下载后必须 `sha256sum -c`”（决策见 `docs/design.md` §60、§61）。复查时又把同类的第四处补上：`dsh.tasks.preview` 收到非字符串 `requestDigest` 时会静默改用计算值，等于丢掉调用方的绑定承诺，现改为拒绝（回归 `test/tasks-events-and-preview.test.mjs`）。

- **发布链路收敛（F1–F4）**：修正 TS 迁移后“只构建到 `dist/` 却从仓库根发布”的链路脱节——`.github/workflows/release.yml` 与 [docs/release.md](docs/release.md) 统一改为先 `npm run build` 再从 `dist/` 发布，并在 `verify` job 把 `npm run build` 置于 `check:version` 之前；新增 [scripts/check-release-path.mjs](scripts/check-release-path.mjs)（校验 `dist/` `npm pack --dry-run` 含全部入口、根不可发虚包且工作流从 `dist/` 发布）与 [`tsconfig.client.json`](tsconfig.client.json) + `check:types`（对 [`client.js`](client.js) 执行严格 `checkJs` 类型检查），双双接入 `npm test` 与 CI；根 [`package.json`](package.json) 设 `"private": true`、移除失效 `files` 并将 `main`/`exports`/`bin` 指向 `./dist/...`（[`build.mjs`](scripts/build.mjs) 构建时生成干净可发布的 `dist/package.json`），[`tsconfig.json`](tsconfig.json) 移除已删除的 `types` 路径。
- **全仓 TypeScript 迁移收口（PR 5b，发布面 100% TypeScript）**：迁移 `lib/` 下最后 11 份模块（[`host-facts.mts`](src/lib/host-facts.mts)、[`config.mts`](src/lib/config.mts)、[`capabilities.mts`](src/lib/capabilities.mts)、[`registry.mts`](src/lib/registry.mts)、[`auth.mts`](src/lib/auth.mts)、[`adapters/redact.mts`](src/lib/adapters/redact.mts)、[`owned.mts`](src/lib/owned.mts)、[`stats.mts`](src/lib/stats.mts)、[`inflight.mts`](src/lib/inflight.mts)、[`advice.mts`](src/lib/advice.mts)、[`version.mts`](src/lib/version.mts)），删除全部剩余 11 份 `types/lib/**/*.d.mts` 临时桥接声明，将 `package.json` 的 `check:version` 指向产物 [`dist/lib/version.mjs`](dist/lib/version.mjs)；发布包内所有 `.mjs` 均由 41 个 `.mts` 编译生成（加上按决策 0.9.4-a 原位 `@ts-check` 保留的 [`client.js`](client.js)）。
- **账本与审批域 TypeScript 收口（PR 5a）**：迁移 `lib/tasks/engine.mjs` → [`src/lib/tasks/engine.mts`](src/lib/tasks/engine.mts)、`lib/approvals.mjs` → [`src/lib/approvals.mts`](src/lib/approvals.mts)、`lib/approval-state.mjs` → [`src/lib/approval-state.mts`](src/lib/approval-state.mts) 与 `lib/pending.mjs` → [`src/lib/pending.mts`](src/lib/pending.mts)，删除对应 4 份 [`types/lib/`](types/lib/) 桥接声明；数据库行类型归口 [`src/lib/tasks/store.mts`](src/lib/tasks/store.mts)（`engine.mts` 复用并重导出），`engine.mts` 专注领域投影（`TaskProjection` / `DerivedPhase` / `AttentionOnceInTxParams` 与各操作入参出参），`approval-state.mts` 与 `pending.mts` 以 `as const` + `Record<State, readonly State[]>` 约束迁移表穷尽性；同步校正 [`src/lib/methods.mts`](src/lib/methods.mts) 的 `TasksEventsResult`（真身字段 `createdAt`/`payload`）与 `PendingApprovalPacket` 类型引用（零运行时改动）。
- **TypeScript 全仓迁移收口（PR 4）**：将插件宿主入口 `index.mjs` 迁至 [`src/index.mts`](src/index.mts)（导出 `HostPluginContext`、`TaskCentreState`、`TaskCentreWiring`、`PublishHandle`、`TaskDispatcher`、`Autopilot` 等装配契约，并补全 [`types/lib/`](types/lib/) 对未迁移辅助模块的声明桥接）；浏览器设置页 [`client.js`](client.js) 因 `tsc` 编译产物会改写缩进/空白导致 SHA-256 与 20,833 B 原文件不一致，按规划兜底原地补充 `// @ts-check` 与纯注释 JSDoc 类型并在零非注释代码改动前提下通过严格类型检查与 `dist/client.js` 保真校验。

## [0.9.3] - 2026-11-19

> 本版主题：把本插件扩展为本机多执行方任务中心——独立 SQLite 任务账本、能力卡与只读探测、有界派发环、三套执行方适配器，以及默认关闭的熔断开关。`PROTOCOL_VERSION` 由 `2026-11-04` 升至 `2026-11-19`。

> 版本说明：`0.9.0`（任务中心）、`0.9.1`（两道对账门禁、机器侧推进环与 A08 修复）、`0.9.2`（六项加固）、`0.9.3`（只读可读性与坏端口下游口径）是同一轮开发的四个阶段，**一次性以 0.9.3 发布**；0.9.0 / 0.9.1 / 0.9.2 都未单独发行。

### 新增

- **任务中心账本与状态机**（默认 `$DSH_HOME/storages/task-center/tasks.db`，WAL + `foreign_keys=ON`）：
  - 新建 15 张表（`schema_meta`、`principals`、`workspaces`、`agents`、`capability_revisions`、`previews`、`tasks`、`mandates`、`attempts`、`events`、`effects`、`inputs`、`approvals`、`artifacts`、`attention`）。
  - 11 态任务状态机、`expectedStateVersion` 乐观锁、基于 `(principalId, idempotencyKey)` 的提交/控制幂等校验、`effects` 持久出箱（带 `lease_expires_at` 租约回收）与一次性 `previews` 绑定。
  - 派生阶段 `derivePhase` 按 8 档优先级现算（`person/delivery` → `person/approval` → `person/reconcile` → `person/answer` → `person/review` → `machine/queued` → `machine/working` → `done`；核对期压过遗留问题见「修复」一节第五条），不写回数据库。
- **RPC、MCP 与 CLI 扩展**（JSON-RPC 方法总数 **17 → 34**，MCP 工具 **11（默认）+ 11（`tasksEnabled: true` 时共 22 个）**）：
  - 新增 13 个任务 RPC 与 4 个代理 RPC（合计 17 个，方法总数 17 → 34）：`dsh.tasks.{preview,submit,get,list,events,cancel,dispatch,pump,reconcile,decideApproval,input,readArtifact,resolve}`（`resolve` 是唯一的人工签收入口，只在 RPC/CLI 面，不进 MCP）；新增 4 个代理 RPC：`dsh.agents.{register,list,probe,get}`。
  - 新增 11 个受开关门控的 MCP 工具：`dsh_task_{submit,list,get,cancel,preview,events,read_artifact,input}` 与 `dsh_agents_{list,probe,get}`（有意排除 `resolve`、`reconcile` 与 `decideApproval`，人工核对、签收与审批留在 RPC/CLI 面）。
  - 新增 CLI 子命令：`dsh-rpc tasks <preview|submit|list|get|cancel|dispatch|pump|reconcile|approve>` 与 `dsh-rpc agents <register|list|probe>`。
- **机器侧自动推进（`tasksAutopilot`，默认 `true`）**：宿主每隔 `tasksAutopilotIntervalMs`（默认 5s）跑一遍有界推进环——先启动到期 `queued` 任务（`tasksAutopilotMaxStart`，默认 2），再推进活跃任务（`tasksAutopilotMaxPump`，默认 4），单遍有步数与截止时间上限，上一遍未完成时跳过。这是外部 agent 经 MCP 提交后任务能自己往前走的唯一机制：MCP 面刻意不暴露 `dispatch`/`pump`，没有这一环时任务会永远停在 `queued`（A08 真机实测）。
- **三个执行方适配器**（统一实现七操作契约 `probe`/`start`/`inspect`/`sendInput`/`cancel`/`events`/`decideApproval`）：
  - DSH 自身基准适配器（`lib/adapters/dsh.mjs` + `createDshAdapterOps`）：注入 7 个会话操作包装，`tasksEnabled: true` 时自动装配；`probe` 只读、`cancel.stopped` 严格以底层确认为准、未校验结果保持 `resultValid: false`。
  - Antigravity 适配器（`lib/adapters/antigravity.mjs`）：通过 `ForceStopCascadeTree` 执行会话树级取消，传入 `projectEnvConfig.projectId` 入项目与 `MODEL_PLACEHOLDER_*` 选模型，不把持久化 locator 写入密钥/CSRF。
  - Codex App Server 适配器（`lib/adapters/codex.mjs`）：通过 `app-server --listen stdio://` 建会话并用 `turn/interrupt` 中断轮次，Windows 下跳过 0 字节 `WindowsApps` 别名或回落 `.codex/.sandbox-bin/codex.exe`。
- **能力卡、只读探测与能力修订**：
  - `capability-card@1` 规范化与哈希，强制必填非空 `limitations[]`，`declared` 与 `verified` 字段分离；`dsh.agents.probe` 只读探测 6 项控制项并记录 `verified` / `partial` / `unknown`（带原因与耗时 `elapsedMs`）。
  - 支持能力修订表（含 `review.diff@1` 基线与 `control_requirements_json` 字段）及策略/降级字段（`policy_revision`、`limitations[]`、`degraded[]`）。
- `degraded[]` **按能力卡里 `controls.<name>.support` 计算**（`start`/`steer`/`cancel`/`inspect`/`events`/`approval` 六项），而不是只看拍平的 `cancel`；任务详情、列表与预览都带该字段。
- **TypeScript 构建链（PR 1a，零业务迁移）**：新增 `tsconfig.json`、`scripts/build.mjs`（编译 `src/**/*.mts` + 原文逐字节复制未迁移文件 + SHA-256 保真与文件数断言）、`scripts/check-dist-fidelity.mjs` 与 `scripts/check-entry-parity.mjs`；`check:docs` / `check:surface` / `check:package` 改扫 `dist/` 产物，接入 `npm run verify` 与 CI。

### 修复

- **自动推进环忘了 `await`**：`lib/tasks/autopilot.mjs` 的 `step()` 读的是 `engine.list(...).items`，而 `engine.list` 是异步的——拿到的是 Promise，“没有任务”看起来和一个空账本一模一样，于是宿主每 5 秒跑一遍、什么也不推，MCP 提交的任务原地停在 `queued`（A08 真机实测：45 秒零推进，手工 `dsh.tasks.dispatch` 立刻成功）。修法是把两处列表查询都 `await`，并把每遍结果写进 `ping.taskCentre.autopilotStats`（遍数、上次时间、启动/推进/失败条数与最后一条错误）；回归钉法见 `docs/design.md` §48。
- **`ping` 其实看不见推进环**：上面那条说“把每遍结果写进 `ping.taskCentre.autopilotStats`”，但 `ping` 是按字段白名单投影的，`autopilot` / `autopilotStats` 两个字段根本没被列进去——“跑了一遍什么也没推”和“根本没跑过”在应答里长得一模一样。投影补齐后，A07 勘察正是靠它才看清外部适配器压根没被装配（见下条）。
- **外部执行方只在显式选中时才装配**：`tasksExternalAdapter` 默认 `none`，此时 `adapters` 里只有 `dsh`；提交给 `antigravity` / `codex` 类代理的任务会在 `startTask` 里撞 `ADAPTER_UNAVAILABLE`，任务留在 `queued`，推进环把这次失败记进 `autopilotStats.lastFailed` 而不是编造一个状态。要真跑外部执行方，profile 里得写 `tasksExternalAdapter: antigravity` 且 `tasksAdapters.antigravity.enabled: true`（A07 真机勘察结论，决策记在 `docs/design.md` §49）。
- **「派发中」之后崩溃会变成幽灵**：`startTask` 先在同一写事务里把任务推到 `dispatching`，然后才 `await adapter.start`；宿主若死在这段 await 中间，账本留下的是「`dispatching`、无 attempt 行、无 locator」。重启后推进环照旧把它当活跃任务喂给 `pump`，`pump` 没有 locator 可读、每遍抛一次 `ADAPTER_UNAVAILABLE`，而 `dispatching` 又计入 `maxConcurrent` —— 一条幽灵就能把并发槽占死、把任务中心拖停。修法：`pump` 对「`dispatching` 且尚无 attempt」的给一段宽限期（`startOrphanGraceMs`，默认 60 秒）静候启动落账，超期转 `needs_reconcile` + `dispatch.orphaned` 交人核对，期间绝不去调适配器事件；宿主停机时先等在途那一遍收尾再关存储（`cleanupTasks` 记 `inFlightPass`，空闲则就地同步关闭），不把 `close()` 塞进正在写账本的事务里。
- **「有 attempt 但没 locator」是同一个坑的另一种形状**：孤儿守卫最初只判「`dispatching` 且没有 attempt 行」，而 `recordAttemptStart({ markRunning: false, runtimeLocator: null })`（或启动成功却没回 locator 的适配器）会留下「有行、无 locator」——守卫被跳过，`adapter.events(null)` 照样每遍抛错。改为按 locator 判断，事件里补 `attemptRecorded` 与 `attemptId` 便于定位；`startOrphanGraceMs` 也按 `maxConcurrent` 的口径归一化（`NaN`/负数回落默认值，不允许静默变成零宽限）。
- **推进环与停机共用一把锁**：定时器原来只判 `shuttingDown`，`drainEffects` 慢于间隔时第二遍会覆盖 `inFlightPass` 并先置空闲，第一遍仍在写账本时 `cleanupTasks` 已判定可以关库。现在 `passRunning` 兼作重入守卫（上一遍含排水未完则跳过本遍），`cleanupTasks` 只在真有在途遍时等待，其余情况同步关闭。
- **核对期被事件名枚举漏掉**：`derivePhase` 原先把 `cancel.unsupported` / `cancel.unconfirmed` / `cancel.failed` / `dispatch.orphaned` 与租约过期当作核对理由，而 `dispatch.failed`、`inspect.unknown` 同样会进 `needs_reconcile` —— 于是阶段跌回 `machine/working`，人看到的是「机器还在干活」，实际在等他对账。改为状态本身即职责：`status === "needs_reconcile"` 一律 `person/reconcile`，不再枚举理由。
- `scripts.test` 新增并接入 20 个任务中心与 CLI/适配器测试套件（全链 47 个测试文件、434 例，本机 434/434 通过；CI 结果见 PR #30），并更新 `catalog.smoke.mjs` 校验 34 个 RPC 方法。
- `dispatch.mjs` 修复了租约到期回收与原子 `maxConcurrent` 门控竞态，防止同一写事务之外并发超发或将任务卡死在 `dispatching` / `in_flight`。
- **取消确认后立刻收口**：适配器回报 `confirmedStopped: true`（DSH 会话真停了、Antigravity 回执里含该 cascadeId）时，同一次出箱排水内把任务从 `cancel_requested` 推进到 `cancelled` 并写 `cancel.confirmed`；此前只把 effect 标完成，任务会悬在 `cancel_requested` 等一个已停会话永远不会发出的事件。Codex 的 `turn/interrupt` 只算受理，故不设该标志。
- **幂等键不再掩盖改过的请求**：`cancel` / `resolve` 的重放分支会比较请求意图（取消原因；处置结论 + 证据引用），同键异载荷抛 `STATE_CONFLICT`（`reason: "idempotency_payload_mismatch"`）。`expectedStateVersion` 属并发护栏、重试时本就会变，不参与比较。
- **`recordAttemptStart` 的 `markRunning: false` 分支加了乐观锁**：绑定 `active_attempt_id` 改为带 `state_version` 条件的写并自增版本，陈旧调用方不再能静默改绑活动尝试。
- **出箱写入加了租约围栏**：效果完成/失败更新要求行仍处于 `in_flight`，租约过期被回收后迟到的回执只记 `skipped`，不覆盖接手者的结果。
- **安全加固（外部安全评审 t3 的四类发现）**：
  - 注册数据不能再挑选可执行文件：`codex` 适配器解析二进制只用插件配置 `tasksAdapters.codex.binary` 与内置发现（`req.binary` / `agent.adapterConfig.binary` 一律忽略），发现器要求普通文件且大小 > 0（跳过 0 字节 WindowsApps 别名）；`dsh.agents.register` 拒绝带 `binary`/`executable`/`command`/`argv` 的 `adapterConfig(Ref)`。
  - 原始适配器异常不再进账本或回执：新增 `sanitizeAdapterFailure`，把任意异常收敛为固定文案 + 短标识码（`code`/`kind`/`phase`/`httpStatus`）并附**白名单 reason**（如 `binary_not_found`、`no_alive_hub`）的可操作文案；未命中白名单的 reason 一律丢弃，原文只进 `logger.debug`。Antigravity 传输加 `redirect: "error"`、请求超时与 1 MB 响应体上限。
  - Codex stdio 加边界：单帧 4 MiB 上限（超限判协议错并关闭）、JSON 帧必须是非数组对象、事件队列上限 500（丢最旧并计 `droppedEvents`，由 `events()` 带出）、stderr 只保留尾部 4096 字符。
  - CLI 与 MCP 入口补齐参数校验：`submit.input` 必须是对象、`list.limit` 1..200、`dispatch`/`pump` 的 `max_steps` 1..1000、标识符必须为非空字符串、数字参数按安全整数与范围校验、JSON 语法失败不进入 RPC。
  - **安全复评（t3b）后的二次收口**：适配器失败日志默认只记 `taskId/operationId/attemptId/code/reason/kind`，原始文本要 `tasksAdapterDebugDetail: true` 才输出且先脱敏截断（512 字符）；新增 `lib/adapters/redact.mjs`，`Bearer` / `ghp_` / `sk-` / csrf 形态在适配器输出与账本落库前统一替换为 `[redacted]`；Codex 帧改严格校验（非对象、错误 `jsonrpc`、非法 `id`/`params`、带 `id` 的未知 method 一律 `failProtocol`），stdout/stderr 用 `StringDecoder` 增量解码，待审批 map 上限 200 并暴露 `droppedApprovals`；MCP `callTool` 在分发前按 `inputSchema` 校验必填项/类型/枚举/范围/未知键。
- **任务开关真的会关（首轮真机冒烟发现）**：`tasksEnabled=false` 原先只挡住 MCP 工具面与宿主装配，RPC 方法本身仍可调用，任务会被收进一个内存库、重启即丢。现在整个 `dsh.tasks.*` / `dsh.agents.*` 家族在有开关关闭时统一回 `-32601`（`data.reason = "tasks_disabled"`），`discover` 也不再宣发这 12 个方法；`catalog.smoke` 同时校验「关着不露、开着全露」两种状态。
- **补上人工签收入口（第三次真机冒烟发现）**：方案 §6.1 要求 `dsh.tasks.resolve` 作为 `review_pending` / `needs_reconcile` 的人工终态处置，实现里只有 engine 方法、RPC 与 CLI 都没暴露，等于任务能跑完却无法签收。现补 RPC `dsh.tasks.resolve`（`taskId` + `expectedStateVersion` + `idempotencyKey` + `disposition: accept|reject|cancel|requeue` + `evidenceRef?`/`note?`）与 CLI `dsh-rpc tasks resolve --expected-version N --decision accept|reject|cancel|requeue`；按计划**不**进 MCP（签收是人的判断，不能让调用方自己给自己验收），并纳入 `tasksEnabled` 熔断名单与 `catalog.smoke` 期望表。
- **开态启动不再被未注册服务拖垮（第二次真机冒烟发现）**：`index.mjs` 原用 `ctx?.get?.("taskAdapterFactories")` 找注入点，而 Cordis 的 `ctx.get(name, strict)` 对未注册服务会抛错，任务中心启动块整体中断后 `taskStore`/`taskEngine` 退回内存库——表现为 `dsh.tasks.submit` 报 `principal not found`、文件库里只剩 schema。现在缺服务视为未注入（try/catch 兜底）、基线身份播种改为 `await` 并记 `seedError`、启动失败记 `startError`，并让 `dsh.ping` 输出 `taskCentre {enabled, mode, ready, dbPath, store, seedError, startError}`；新增回归用例（`ctx.get` 抛错时仍启动、播种真正落盘）。
- **安全复评第三轮（t3c）收紧**：凭据形态补 `Basic` / `Cookie` / URL userinfo / `github_pat_` / `AKIA` 五类（Cookie 止于分号，避免吞掉整行）；`redactDeep` 只对字符串凭据替换、放过 `maxTokens`/`tokenCount` 这类计数键，深度截断标记改为 `[truncated: depth]`；MCP 入口校验改用 `Object.hasOwn` 并显式拒绝 `__proto__`/`constructor`/`prototype`，递归上限由 2 提到 8；Cookie 头按逐对遮盖（整行遮盖会吞掉同一行后面的 URL），Bearer 只认"长且非纯字母"的串（`Bearer of bad news` 是句子不是凭据），键名补 `sessionKey` / `x-api-key` / `passphrase` / `credential`。**边界如实记**：任务结果按产出原样落账，脱敏只覆盖适配器失败文本与调试日志——结果是交付物，改写结果等于篡改。
- **补上任务事件入口（重启前补齐的第四处缺口）**：方案 §6.1 要求 `dsh.tasks.events`，引擎里也早就有 `events()`，但 RPC/CLI 从未暴露——任务中心自己的日志从外部读不到。现在 `dsh.tasks.events`（`taskId` + `afterSeq` + `limit`）与 `dsh-rpc tasks events` 都在，MCP 面不加（事件属于排障路径，不是驱动路径）。
- **首轮真机端到端跑出来的三条缺陷（离线套件都看不到）**：①`inspect` 轮询没有稳定事件标识，同一个会话状态被当成新报告反复应用——真机上实录 46 次 `report.invalid`、74 条重复人工问题，任务卡在 `waiting_input`；现由适配器按「会话 + 状态 + 轮次」派生固定 `adapterEventId`，只在状态真变时换号，`pump` 把它交给账本去重。②同一问题重复开单——人工问题改为按 `(任务, 类型, 提问)` 幂等，已开的不再新建。③**执行方只回「请求已受理」而没确认停止时，任务会永远停在 `cancel_requested`**——现在升级为 `needs_reconcile` 并记 `cancel.unconfirmed`，交人工核对，不再等一个已停会话永远不会发出的事件。
- **未校验的结果没有人工裁决入口（同一轮真机端到端跑出的第四处，属方案级缺口）**：DSH 适配器按「不加验证就不算有效结果」的诚实规则永远报 `ready` + `resultValid: false`，而 `dsh.tasks.resolve` 只接受 `review_pending` / `needs_reconcile`——默认适配器的正常链因此永远到不了 `succeeded`，人工既不能签收、也不能判负，只能看着任务停在 `running` 加一条 review 问题。现在：任务停在 `running` / `waiting_input` / `waiting_approval` 且存在未关闭的 `review` 类人工问题时，`resolve` 允许裁决，并**先推一步 `review_pending`（事件 `review.promoted`，`resultValid: false` 如实标注）再按处置落终态**；成功路径仍然只有一条，审计上能看出「这次成功是人工裁定未校验结果得来的」。没有 review 问题时仍按原规则拒收。同时 `derivePhase` 把 `cancel.unconfirmed` / `cancel.failed` / `dispatch.orphaned` 也认作核对信号，`needs_reconcile` 不再显示成 `machine/working`。
- **第五、第六处真机缺陷：把「非阻塞信号」当成了「在等人」**：①DSH 会话启动时会写一条 `approval/policy`（内容形如 `{ policy: "ask" }`，说明后续审批会怎么问），适配器却把任何 `approval/*` 记录都判成「等待人工批准」——真机上这条策略记录把已经 `turn/end completed` 的会话挂成了 `waiting_input`，还开了一个谁也没法回答的问题（同期 `dsh.approvals.pending` 返回 `{ pending: [], count: 0, timedOut: true, mode: "off" }`）。现在只有 `approval/requested` / `approval/request` 才阻塞，`approval/policy`、`approval/resolved` 等一律报 `progress`；「有没有待批」的权威判断仍留在会话状态那条路（`waiting_approval`）上。②`needs_reconcile` 的任务如果还挂着一条没关的 `input` 问题，阶段会显示成 `person/answer`——核对期被遗留问题挤到后面，人看到的是「等你回答」而不是「等你核对」。现在核对期排在问题之前（`person/reconcile` 先于 `person/answer`）。两处都补了回归用例。
- **第七、第八处真机缺陷：同一个问题问了两遍，核对期又被租约压住**：①两次 `pump` 都读到「已就绪但产出不合 schema」时，代码走的是裸 `INSERT INTO attention`，同一个问题开出两条人工问题——真机上 `q_2c53faca…` 与 `q_a4180425…` 相差 186 毫秒并存，直到签收才一起关掉；现在这条分支也走按 `(任务, 类型, 提问)` 去重的 `attentionOnceInTx`，问一次就够，两条 `report.invalid` 仍都留在事件里。②任务因「停止没被确认」进了 `needs_reconcile`，可派发期写的 `effects.lease_expires_at` 还没到期，而派生阶段的核对期分支要求租约缺失才算——于是人看到的是 `machine/working`（机器还在干活），实际在等他对账；现在 `cancel.unsupported` / `cancel.unconfirmed` / `cancel.failed` / `dispatch.orphaned` 任一出现即算核对到期，租约挂不挂着都不影响。
- **能力卡的探针从来没接到适配器上**：`dsh.agents.probe` 按控制项要一组探针函数，而适配器是把六项控制一次性摆在 `probe()` 的返回里，中间那一层没人接——于是六项一律 `rejected`、卡的状态永远停在 `unknown`，再健康的执行方也验不出来。现在探针从「被指派适配器」的只读控制表派生（一轮一次往返，不再六次打同一个语言服务器），并补两条回归：活适配器必须验得出来，没装适配器的代理必须如实停在 `unknown`。
- **预览不再接受「不相干的能力修订」（重启前补齐的第五处缺口）**：`dsh.tasks.preview` 过去只校验修订存在，不校验它属于所选实例、也不校验探测是否过期，还会把候选列表留空。现在：修订必须在该实例声明的 `capabilityRevisions` 里（否则 `CAPABILITY_VERSION_MISSING`）、探测过期即拒（`PROBE_STALE`），并把同类其它实例的排除原因（`AGENT_DISABLED` / `PROBE_STALE`）与选中项一起写进 `candidates[]`。
- **顺带修掉一个会吃掉声明的 bug**：`dsh.agents.probe` 重写 `capabilities_json` 时会丢掉已发布的能力修订，导致「注册→探测→预览」直接失败；现在探测只更新证据，不动已发布的能力集合与项目绑定。
- **注册即发布能力修订（首次真机冒烟发现）**：`dsh.agents.register` 过去只写 `agents` 行，`capability_revisions` 永远为空，而 `dsh.tasks.preview` / `dsh.tasks.submit` 都要求修订 id —— 干净主机上任务中心实际不可用。现在卡片的 `capabilities[]` 在注册时发布为不可变修订（id 由卡片哈希 + 能力派生，同卡幂等、换卡换版本），写类能力必须把 `cancelPolicy` 标 `required`，`dsh.agents.list` 会回显每个实例的 `capabilityRevisions`。
- **人工问答与产物读取接上**：新增 `dsh.tasks.input`（执行中回答，走 effects 队列投递，带幂等键、载荷冲突、问题归属与陈旧 attempt 拒收）、`dsh.tasks.readArtifact`（按窗口读取已索引产物，非 UTF-8 回 base64）、`dsh.agents.get`（读回单个执行方的卡片与已发布能力修订）。报告里声明的产物按路径/大小/哈希逐条校验后入索引，校验不过的写 `artifact.refused` 事件而不是静默丢弃。
- **MCP 工具名对齐方案**：`dsh_tasks_*` 更正为 `dsh_task_*`，并补齐 `dsh_task_preview`、`dsh_task_events`、`dsh_task_read_artifact`、`dsh_task_input`、`dsh_agents_get`（共 22 个工具；`resolve`、`decideApproval` 仍不进 MCP）。
- **两道对账门禁（0.9.1 开发期补）**：0.9.0 这几轮里，同一批数字（RPC 方法数、MCP 工具数、测试文件数、用例数）在 README / README.en / CHANGELOG 三处被一次性补丁脚本改过七次；方案与实现之间的接口面也没有任何机器核对，`dsh.tasks.resolve` 就是「方案写了、实现漏了」拖到真机才暴露。现在两件事都变成门禁：①`npm run check:docs` 现算能算的——方法数取 `lib/methods.mjs` 的目录、MCP 工具数取 `bin/dsh-rpc-mcp.mjs` 的 `BASE_TOOLS`/`TASK_TOOLS` 两张表、测试文件数取 `package.json` 里 `test` 链上的 `node test/*.test.mjs`；只有用例总数要整跑才知道，记进 `docs/counts.json` 当唯一来源。锚点规则覆盖中英两份 README 与 CHANGELOG 最新一节的数字，锚点消失也判失败（说明那句话被改写了，规则该跟着更新）。`npm run docs:counts` 幂等刷写：演练时把 375 改成 374，`check:docs` 精确报出 `README.md:79`，写回后与改动前的 SHA256 完全一致；把 `counts.json` 抬到 376 能一次刷中 9 处，恢复后同样字节一致。②`npm run check:surface` 拿 `docs/api-surface.json`（方案接口面快照，含方案文档 sha256）对代码，两个方向都查：方案要求的 14 个 RPC / 22 个 MCP 工具 / 5 条 CLI 必须真实存在；任务族与代理族的每个 RPC、MCP 工具、CLI 子命令必须要么在方案里、要么在快照的 `implementationOnly` 里如实记着（`dispatch`/`pump`/`reconcile`、`agents.register` 与方案只写了主干的 CLI 都在那里）。负向演练同时塞「一个方案要求但代码没有的 RPC」与「一个从声明里删掉的既有 RPC」，两条都被抓出。两道门禁都接进 `npm test`、CI 与 `prepublishOnly`；快照进仓库、方案文档不进，CI 只读快照即可对账。
- **0.9.2：复核 NOTES 的六项待办收口**（不在阻塞清单里，但都是「该由机器证明的地方还在靠手填/靠自我声明」）：；`docs/design.md` 的 §7 历史快照后补了「现行口径（2026-11-19）」注，注明 `methods 41 → 85`、`client 6 → 8`、`edge 24 项但本机 23/24`（第 21 项 `create without a cwd` 因宿主返回 `cwd: null` 失败，属既有行为，非本次引入）。

### 0.9.2 收口

合并前复核（Antigravity，`VERDICT: PASS`）提了两条 medium，两条都修了：

- **`repeated` 不再替「等待中」背锅**：`blocked` 分支原来把 `attentionOnceInTx` 的 `deduplicated` 丢掉，只要任务已经在等就写 `repeated: true`；等待中收到另一个问题时事件会骗人。现在只认去重命中。
- **只读文本也要写「未校验」**：MCP 的 `formatTaskSummary` 原来只把 `result` 打进正文，`resultValid: false` 只留在 `structuredContent` 里；只读文字的一方会把未过校验的结果当成已验过。现在 `result` 行带 `(unvalidated: failed schema validation)`，meta 行重复一次。

前两轮合并前复核留下的六条非阻塞待办，本版一次收掉：

- **未校验的结果看得见，签收留痕**：`applyReport` 在 `ready` + 校验失败时把结果写进 `result_json`（`result_valid = 0`），任务详情里能看到它、但不会被当成成功；`resolve` 的 `task.resolved` 事件带 `resultValid`，人工裁决未校验结果时再加 `acceptedUnvalidated: true`。顺手修掉同处的两处真缺陷：`blocked` 分支把 `attentionOnceInTx` 的返回值丢掉、去重命中时对外回报一个不存在的问题号；同一份 blocked 报告重复投递会撞 `waiting_input -> waiting_input` 非法迁移（现在只补一条 `attention.opened`，标 `repeated: true`）。
- **`attentionOnceInTx` 的粒度**：去重键从 `(task, kind, prompt)` 扩到 `(task, kind, prompt, attempt_id, options_json)`——同一遍仍然只问一次，但换了 attempt 或换了可选项就是另一个问题。
- **Codex 探针改成真握手**：以前只看二进制在、`--version` 能跑就给六项控制全绿。现在要真的起 `app-server --listen stdio://` 并收到 `initialize` 应答才发布控制表，且 `approval` 一律 `false`（codex 的审批语义没有真机证据）；握手超时、子进程起不来（`EPERM` 之类）、应答不对，都只报原因、不给控制表，能力卡停在未证实。
- **孤儿派发真的会释放并发槽**：新增集成回归「`maxConcurrent: 1` + 崩溃留下的孤儿 `dispatching` + 排队任务」，证明推进环把孤儿升成 `needs_reconcile` 之后，唯一的槽位会释放、队列在下一遍被服务。
- **`dispatching` 崩溃窗口的隔离演练**：`audit-tmp/smoke-090/a04b-dispatching-crash.mjs`——worker 子进程在「`dispatching` 已写、attempt 未落库」时被 `exit(9)` 真杀掉，父进程重开账本断言崩溃现场（停在 `dispatching`、无 attempt 行），再让推进环接手：`needs_reconcile` + `person/reconcile` + `dispatch.orphaned`（证据里 `attemptRecorded: false`）、全程不碰适配器事件接口、槽位释放后队列继续走。11/11 PASS。
- **两道门禁收紧**：①`docs/counts.json` 的用例数不再能手填——`npm run count:cases` 真跑一遍 TAP 才写，并附测试文件摘要与声明条数；`check:docs` 重算后遇到「文件变了数字没重算」或「用例数少于声明条数」直接失败，`docs:surface`/`docs:counts` 也刷不出一个假的数。②`check:surface --write` 新增 `implementationOnly` 条目必须显式 `--accept-new`，否则只列出来并失败，不再能靠重抽快照把新接口自我声明掉。

- 计数：全链 47 个测试文件、434 例，本机 434/434 通过。

### 0.9.3 开发期

- **宿主挑的端口可能是 `fetch` 直接拒绝的端口**：桥没有自己的监听器，端口来自宿主 Web 服务。`fetch` 按标准会拒绝一批「bad port」（`989`、`1720`、`4045`、`5060`、`6000`、`6665`–`6669`、`6697`、`10080` 等），拒绝发生在建立 socket 之前，因此整条 `cause` 链里没有任何 errno——客户端只能看到 `fetch failed`，`error.code` 是 `undefined`，而且重试逻辑按「只重试 `ECONNREFUSED`」的规矩不会介入。这正是 0.9.2 整链偶发失败的原因（测试里的「死端口」被系统分到了 `6667`）。三处一起改：①`lib/transport.mjs` 导出 `FETCH_BLOCKED_PORTS` / `isFetchBlockedPort()`，并把这种拒绝命名为 `EBADPORT`（不是猜 errno，是 `fetch` 自己给出的原因）；②`lib/client.mjs` 的消息带上最深层 cause，并提示换端口或 `--url`；③`index.mjs` 发布端点时若发现宿主端口在拒绝名单里，启动日志直接告警一次——服务端看起来健康、客户端全连不上，是最难查的那种组合。
- **`EBADPORT` 下游口径与测试桩全链收口（`0.9.3-b/c/d`）**：`transportCode()` 仅在整链无错误码时命名 `EBADPORT`，`isFetchBlockedPort()` 对字符串严格校验 `/^\d+$/`；`withEndpointRetry` 在 `EBADPORT` 且 `endpoint.json` 已切到新 URL 时允许安全重放一次，URL 未变则原样抛 `EBADPORT`；`index.mjs` 启动告警改按端口号去重；`dsh-rpc health --wait` 遇到 `EBADPORT` 立即失败并提示换端口/`--url`（退出码 `3`，CLI 不再误导为 `"is it running?"`）；MCP 任务/代理工具对客户端传输错误（`EBADPORT`/`ECONNREFUSED`/`ECONNRESET` 等）原样透出而不再被 `sanitizeAdapterFailure` 覆写；抽取 `test/helpers/stub-server.mjs` 让 `client`/`wait`/`abort`/`cli-mcp-regressions` 统一跳过 `FETCH_BLOCKED_PORTS`。
- **复核第三轮的三条 low（`0.9.3-e`）**：①MCP 侧的传输透传判定原来是「任何 `E[A-Z0-9]+` 开头的码」，与适配器的 `ENOENT` 撞形——改成显式白名单 `CLIENT_TRANSPORT_CODES`（`EBADPORT`/`ECONNREFUSED`/`ECONNRESET`/`EPIPE`/`ETIMEDOUT`/`UND_ERR_*`），适配器 errno 不再有搭车的机会；②`formatToolError` 的 `NEXT_BY_CODE` 只收了 `EBADPORT`，透传 `ECONNREFUSED` 时提示是一句「next: ECONNREFUSED」等于没给下一步，补齐四种常见传输码的可执行提示（未知码仍直说，不许编）；③CLI `tasks list` 的非 JSON 输出没复用 `formatTaskListLine`，读文字的人看不到 `unvalidated`/`degraded`/`attention`，现与 MCP 同源。
- **只读文本显示口径补齐（`0.9.3-a`）**：`formatTaskSummary` 移入 `lib/mcp-format.mjs`（并由 `bin/dsh-rpc-mcp.mjs` 保持重导出），纯文本补齐 `degraded[]`、`pending.attention`（类型/问题号/提示/选项）与 `pending.approvals` 且在 `meta` 行保留计数防止被 `capText` 截断；`dsh_task_preview` 改用 `preview <previewId>` 专有标题（不再出现 `task ? · unknown · unknown`）；`dsh_task_list` 与 CLI `tasks get` 非 JSON 输出补齐 `resultValid` / `unvalidated` 与降级/待处理摘要。

### 行为变化

- **默认完全关闭（与 0.8.1 行为零差异）**：`tasksEnabled` 默认 `false`；未显式开启时不会创建 `tasks.db`，MCP 工具列表保持 11 个，不改变任何既有 `dsh.*` 会话语义。
- **开启后的变化**：设置 `tasksEnabled: true` 并重启宿主后，首次启动在 `$DSH_HOME/storages/task-center/tasks.db` 初始化账本并播种 `local-operator` 与 `local` 工作区，启动 5 秒定时 `drainEffects` 出箱排水（`.unref()`），MCP 侧多出 11 个任务/代理工具（8 个 `dsh_task_*` + 3 个 `dsh_agents_*`）。

### 关闭方式

- `tasksEnabled: false`：彻底关闭任务中心初始化、DB 打开、定时器与任务 MCP 工具暴露（已有的 `tasks.db` 保留不动）。
- `tasksExternalAdapter: "none"`：仅保留 DSH 基准适配器，不装配 `antigravity` 或 `codex` 外部适配器。
- `tasksMaxConcurrent: 1`：有界派发并发上限（整数 `1..32`，默认 `1`），超限时 `startTask` 直接报 `STATE_CONFLICT`。
- `tasksRequireReconcileOnUnknown: true`：未识别状态或无结构化 `attention` 的 `blocked` 报告一律转 `needs_reconcile`（默认 `true`）。
- `tasksPreviewTtlMs: 300000`：预览有效期（整数 `1000..3600000` ms，默认 `300000`），超时或已消费均拒绝提交。
- 其余五个开关见 README 的十项配置表：`tasksDbPath`（默认 `null`）、`tasksProbeTimeoutMs`（默认 `5000`）、`tasksAdapters`（默认 `{}`）、`tasksDispatchMaxSteps`（默认 `50`）、`tasksAdapterDebugDetail`（默认 `false`，仅在打开时把脱敏截断后的适配器原始文本写进 debug 日志）。

## [0.8.1] - 2026-11-18

> 0.8.0 未单独发布，其观测能力并入本版。
> 本版主题：让调用方看得见轨迹、算得准超时、问得清能力。新增 A 轨迹投影、B `dsh_history`、D `dsh_capabilities`，并把 E 超时契约与 F 结果上限改成实话。

### 新增

- A trace 投影：`dsh_ask`、`dsh_wait` 与 CLI `ask`/`wait`（`--trace`）新增四档工具调用轨迹渲染（`none` / `errors` / `summary` / `full`，默认 `errors`，可通过 `config.traceDefault` 配置）；元信息行在非 `none` 且存在失败调用时附带 `(${m} errors)` 后缀；`trace: "full"` 附带结构化 `structuredContent`（含工具明细与 `outputTruncated`）；传入 `none` 可逐字节恢复既有输出。
- B `dsh_history`：
  - 新增第 10 个 MCP 工具 `dsh_history`（配套纯格式化模块 `lib/history-format.mjs`），用于只读查看指定会话最近的事件窗口（工具调用、工具结果、轮次结束、审批与沙箱变化等），**不会激活**会话的 agent。
  - 支持参数 `session_id`（必填）、`limit`（默认 40，上限 500）、`kinds`（默认 `["tool/call","tool/result","turn/end"]`，传 `["*"]` 取全部类型）、`since`（只保留 `seq > since`）、`max_chars`（`0` 表示不限，正数从最新记录起截断并置 `truncated: true`）。
  - 输出包含摘要头、受展示预算约束的逐条事件文本（超预算时末尾提示 `… +N more (raise limit or max_chars)`）以及始终附带的 `structuredContent`。
  - 增量边界：`since` 与 `kinds` 是在"最新 `limit` 条事件"的窗口内过滤，若增量超过 `limit` 条会静默不完整，需要大增量时须调高 `limit`（最高 500）；摘要头里的 `turn` 与 `running` 始终反映未过滤的整段窗口。`limit` 本身只是传给会话存储的窗口提示，不是硬上限——摘要头一律报告实际到达的事件条数。
  - 混版诚实性：当桥连着的插件早于 0.8.1（不认 `since`/`kinds`/`max_chars`）时，回答不再打印 `filtered:` 行，而是改印 `note:` 说明"这些记录是未过滤、未截断的整段窗口，请升级插件或自行过滤"，并在 `structuredContent.note` 中同步同一句话。
- C `structuredContent`：`dsh_ask` / `dsh_wait` 在 `trace: "full"` 时、以及 `dsh_history` 在任何档位下，MCP 结果的 `structuredContent` 携带机器可读载荷（工具明细、事件记录、`truncated` / `note` 等），人读文本与机器消费各取所需；非 `full` 档位不附带，以免改变既有调用的字节形态。
- D `dsh_capabilities`：
  - 新增第 11 个 MCP 工具 `dsh_capabilities`、RPC 方法 `dsh.capabilities`（及 `dsh.discover` 目录项）与 CLI 子命令 `capabilities`（`--sections`、`--max-chars`、`--session`、`--json`），只读返回当前 Harness 的八节能力快照（`identity`、`runtime`、`permissions`、`tools`、`mcp`、`sessions`、`workspace`、`plugins`），**不创建、不恢复、不触碰**任何会话，无活跃会话时同样可用。
  - 采集（`lib/host-facts.mjs`）与纯格式化投影（`lib/capabilities.mjs`）分离：只有采集层通过白名单调用 `ctx.get(...)`（仅限 `permissionPresets`、`tools`、`sessions`、`workspaceRegistry`、`loader`），缺失或抛错一律降级为单行 `<id> [unavailable] — <reason>` 而不抛异常，不读 profile YAML、不调 `which`。
  - 每节带独立状态（`ok` / `partial` / `unavailable`）与来源标签 `source`；`mcp` 只按 `^mcp__([^_]+(?:_[^_]+)*?)__` 归并当前实际可调用的 MCP 工具并明示"非 profile 服务器清单"，每节工具名上限 40 个（附 `+N more`），全文默认上限 `max_chars = 8000`（`0` 不截断、硬顶 `40000`），附 `structuredContent`（`sections`、`truncated`、`missing`）。
- E 超时契约：`dsh_ask.timeout_ms` 与 `dsh_wait.timeout_ms` 保持 `3600000` 上限，但在 schema 描述中明确外层 MCP 客户端单次调用超时（如 Codex 默认 `tool_timeout_sec = 900` s）先于桥上限生效、长任务应走 `wait:false` + `dsh_wait({ session_id, since })`；新增纯模块 `lib/advice.mjs`，当 `dsh_ask(wait:true)` 或 `dsh_wait` 在 `>= 600000` ms 预算上超时时每会话一次性追加 `advice:` 提示块（有界去重 200 个会话，可通过 `config.timeoutAdvice: false` 关闭；`dsh_ask(wait:false)` 永不追加）。
- F 结果护栏：新增 `config.maxResultChars`（默认 `20000`，允许 `0..200000`，`0` 表示不截断）与 `lib/mcp-format.mjs` 的 `capText`；仅对 `formatToolResult` 的轮次正文块（`content[1]`）做边界对齐截断并附截断说明，`session`、`— meta`、`trace:`、`note:`、`reason:`、`advice:` 与 `next:` 块均原样保留。

### 修复

- `npm test` 现在包含 `trace-format`、`history-format`、`advice` 三个套件——它们此前不在 CI 链里，等于新写的断言从未被跑过。
- `dsh_history` 的 `limit` 属性描述不再暗示硬上限：它只是传给会话存储的窗口提示，摘要头一律报告实际到达条数。

### 行为变化

- **默认多出 `trace:` 块**：`dsh_ask` / `dsh_wait` 默认 `trace: "errors"`，结果里会出现工具调用轨迹块，元信息行在有失败调用时多出 `(M errors)` 后缀。要保持 0.7.x 的逐字节输出，设置 `traceDefault: "none"` 或在调用时传 `trace: "none"`。
- **轮次正文有默认上限**：单次 MCP 结果的正文块默认最多 20000 字符，超出时截断并附说明（见 `maxResultChars`）。
- **长预算超时会多一条建议行**：当 `dsh_ask(wait:true)` 或 `dsh_wait` 在 `>= 600000` ms 的预算上真的超时，结果末尾会出现一次 `advice:` 块（每个会话只出现一次）。
- **工具数量从 9 个变成 10 个**：`dsh_history` 加入工具面，按工具枚举做缓存的客户端需要重新拉取 `tools/list`。

### 关闭方式

- `traceDefault: "none"`：恢复到 0.7.x 的结果形态（不渲染轨迹、不改元信息行、不附带 `structuredContent`）。
- `maxResultChars: 0`：关闭正文截断，单次结果不设上限（`0..200000` 之间的任何值都可用作新上限）。
- `timeoutAdvice: false`：不再追加 `advice:` 提示块。
- `dsh_history` 无需开关：它只读事件窗口、不激活 agent、不改任何会话状态；不调用即无副作用。

## [0.7.8] - 2026-11-18

> 本版已于 2026-11-18 发布到 npm（`@punchact/dsh-rpc-agent@0.7.8`，latest），由 GitHub Actions 的 OIDC 发布并带 SLSA provenance。这一版把审批闸门的持久额度改成**跨进程事务**，并收口 gate 关闭与粘性会话上的并发竞态；升级前请先读本章末尾的「说明」。

### 修复

- 审批 waterfall 不再因下游 listener 抛错而重调已消费的 continuation；权限恢复失败保留可恢复台账，并在 gate 关闭/恢复未完成时阻止新的放宽。
- 持久审批额度使用跨进程事务和单调票据：已结算记录折叠为计数，旧票据重放不再恢复额度或重复计费，未结算票据不受 TTL/容量清理影响；损坏账本保留原件并停止写入。
- gate 关闭会等待已批准的下游 continuation，恢复预设后终止尚未执行的调用；同项目 `wait:true` 并发请求共享会话并排队，模型与权限在各自提交前应用。
- 粘性会话复用应用请求的会话选项；同项目并发首次 ask 共享会话创建；注册表并发更新使用串行写入和唯一临时文件。
- 客户端合并取消与超时预算、检查 HTTP/JSON-RPC 错误响应；MCP 完整返回轮次正文，支持通过 `since` 游标续读；CLI/MCP 参数及错误路径对齐契约。
- 发布诊断仅记录 HTTP 状态和白名单声明，不输出 OIDC token 或响应正文。

### 说明

- **升级前先停旧写者**：多个进程共享同一份审批台账时，先停掉跑旧版本的进程再升级，并备份 v1 台账（`$DSH_HOME/dsh-rpc/approvals.json`）；回滚到旧版本需要这份备份。
- **孤儿锁**：进程持有台账锁时被杀会留下孤儿锁，获取锁 10 秒后超时。恢复时停掉所有写者、核对 `owner` 记录、备份台账，**只删孤儿锁目录**——台账与欠账记录本身不动。

本文件记录每个对外版本改了什么。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

只有**对外可见的行为变化**才值得单独一行：新方法、语义变化、修掉的 bug、会影响使用者的坑。
内部重构与措辞调整不记。

## [0.7.7] - 2026-11-06

> 本版已于 2026-11-06 发布到 npm（`@punchact/dsh-rpc-agent@0.7.7`，latest）。这一版把审批闸门里两处"只在内存里，重启就没了"的东西写到磁盘，并给 `history` 补上它一直缺的期限。

### 新增

- **审批台账落盘**（`lib/approval-state.mjs`，默认 `$DSH_HOME/dsh-rpc/approvals.json`，0600、`.tmp` + rename 原子替换）：每会话已用的升权次数、本桥拥有的会话，以及"这次放宽还没还回去"的欠账，重启后都还在。额度不再因为一次重启而重置，所有权也不再因为重启而静默失效。
- **孤儿放宽在启动时收回**：进程被杀时 `dispose()` 跑不到，宿主那边可能仍停在 `danger-full-access`；下一次启动会读台账把欠的 preset 还回去，然后清掉记录（还失败的只记 warn，不无限重试）。
- `historyBudgetMs` 配置（默认 30000，钳在 100..120000）：一次快照读取最多等多久。

### 修复

- **`history` 补上期限与有界收尾**：原先 `await iterator.next()` 和 `finally` 里的 `iterator.return()` 都没有上限，宿主不答就一直挂着；现在超时返回 `-32005`（"the Harness stopped answering"），收尾最多等 1 秒。

### 说明

- 台账只在 `approvals.mode` 不是 `off` 时写入；关掉审批不产生文件。
- 两个进程同时写同一份台账时按字段合并：次数只取更大的（并发最多让额度少减一次，绝不会白送），所有权只增不减，`widenedTo` 取更新的那一份。

## [0.7.6] - 2026-11-06

> 0.7.6 与之前几版都还没有发布到 npm（npm 上仍是 0.5.3）。这一版修的是 0.7.5 里的一个**致命实现错误**：`tools/post-execute` 的签名是 `(exec, result, next)`，0.7.5 写成了 `(exec, next)`，于是它把"结果"当成了延续函数、从没调用它、返回了 `undefined` —— 工具注册表对返回值读 `.kind`，**这台机器上每一次工具调用都会以 Cannot read properties of undefined (reading 'kind') 失败**，连 `read` 都不例外。装上它之后整个工具层不可用，只能靠卸载插件 + 重启恢复。

- **修 `post` 的参数次序与返回值**：改成 `(exec, result, next)`，并且永远返回一个决策（没有 `next` 时返回 `{ kind: "accept" }`），不再可能把 `undefined` 交给注册表。
- **两个监听器都加兜底**：`pre`/`post` 内部任何异常都降级成"这个闸门不存在"（调用原样放行）并记一条 warn。闸门坏掉的后果应该是**不生效**，不是把所有工具打死——这是 0.7.5 用一个 TypeError 换来的教训。
- **新增三条守门用例**：`tools/post-execute` 的返回值必须是指下来的决策（且没有延续函数时不得是 `undefined`）、delegate 模式下普通工具调用原样通过、闸门内部抛错时调用仍然通过。

## [0.7.5] - 2026-11-06

> 0.7.5 与 0.7.4、0.7.3、0.7.1、0.7.0、0.6.0、0.5.4 都还没有发布到 npm（npm 上仍是 0.5.3）。这一版是第三次独立审计（Antigravity）之后按"类"修的：0.7.4 把永久放宽改成有界放宽，但**有界依赖"下游一定正常返回"这个控制流假设**，假设不成立时会话就永久停在 `danger-full-access`。

- **放宽有了事务边界**：被批准的那次调用无论正常结束、下游应答者抛错、结果处理抛错还是被取消，预设都会恢复（`post` 用 `finally`、`dispose()` 在插件卸载时兜底）；`restores` 的键是 `sessionId + callId`，不同会话不会串；**没有 `callId` 的调用在发问之前就被拒**，不再出现"先恢复再执行"还白扣一次额度。
- **轮次停在待批时立刻返回**：`delegate` 下 `dsh_ask`/`dsh_wait` 返回 `status: "waiting-approval"` 与 `pendingApproval`，而不是阻塞到 `deadlineMs`。此前调用方被阻塞在**同一个**工具调用里，永远等不到自己该回答的问题，60 秒期限必然过期。
- **决策包不再有"缩写"漏洞**：`argv` 也走脱敏与 4000 字截断（此前直接取原始 `command`，既是明文也可能超长）；嵌套对象整棵子树按键名打码，值里夹带的 `Bearer …`/`token=…` 由值级清扫兜住；`reason` 同样脱敏并截到 500 字。MCP 侧改为展示 `args`，并标出 `untrusted` 与截断状态。
- **所有权不再能靠注册表夺来**：删掉"注册表认识就认领"的逻辑（它让人类 GUI 会话可被登记后夺取），`remember()` 只对已拥有的会话写表；`isOwned` 断言缺失时闸门**沉默**而不是接管全部会话。
- **改预设也是升权通道，一并纳入**：非本桥创建的会话不能改预设；`approvals.mode` 不是 `off` 时，`configure` 不能把会话直接升到 `danger-full-access`（要升就让工具去问）。
- **读不到当前预设就拒绝**：`readPreset` 返回 null 时不再兜底成 `"workspace-write"`（那会把 `read-only` 会话悄悄提权），直接拒绝并说明原因。
- **升权窗口期的搭便车被拦住**：同一会话在窗口期内，不升权的调用会被**扣留**（不算拒绝、不进 `approvals.denied`），直到窗口关闭。
- **额度与窗口的检查顺序修正**：先看"是否已有升权在跑"再看额度，避免只剩 1 次时误报"额度耗尽"。

## [0.7.4] - 2026-11-06

> 0.7.4 与 0.7.3、0.7.1、0.7.0、0.6.0、0.5.4 都还没有发布到 npm（npm 上仍是 0.5.3）。这一版是两份独立审计（hy4 对抗性、mimo 一致性）之后的加固，**修的是 0.7.3 里真实存在的四类问题**，其中两条会让人以为"批准过一次就等于永久放宽"。

- **`allow-once` 真的只放宽一次调用**：批准后临时切换该会话的 permission preset，调用结束（`tools/post-execute`）立刻恢复原预设，另有 5 分钟兜底定时器；下游应答者拒绝时立即回滚，且**不扣额度**。此前是一次批准永久改宽，与"a decision about that command, not a general grant"的文案自相矛盾。
- **每会话 3 次的额度改成同步预占**：并发升权不再能突破上限；同一会话同时只允许一个升权调用在跑，同一 tick 的多个请求只会产生一条待批记录（此前 5 个并发请求会全部被批准）。额度仍在内存里，宿主重启会清零——这是已知边界，写进了 README。
- **待批请求的 id 改随机 UUID**：原来的顺序号可以被猜，配合"任何持同一 token 的进程都能列出并批准"构成跨会话越权面；`pending` 不带 `sessionId` 时仍可列出全部，但回答不再靠猜 id。
- **决策包带上整包参数**：新增 `args`（脱敏后的完整参数 JSON，凭证形状的值打码，上限 4000 字）、`argsTruncated` 与 `untrusted: true`；`reason` 截断到 500 字。此前 `argv` 只取 `command` 或 `path`，一个把内容放在 `content` 里的写文件请求看起来是空的。
- **升权提示不再替调用方做决定**：沙箱拒绝时的 `next` 只带 `session_id`，不再附 `permission: "danger-full-access"`。桥不该教外层 agent 直接升权——那等于让被挡住的 agent 用自己的措辞推动审批。
- **`sandbox_permissions` 读不出值时 fail-closed**：非字符串一律当作"无法识别的升权请求"交给白名单拒绝，不再静默放行。
- **所有权跟着会话走**：粘性复用与显式 `sessionId` 现在也会在"桥的注册表认识这个会话"时认领所有权，宿主重启后不再静默失守。
- **`waitMs` 非法值报 `-32602`**：小数、负数、超过 120000 都直接报错，不再静默钳制（文档一直说会报错）。
- **已取消的调用不会留下问题**：`open()` 会检查传入的 signal 是否已经 abort，已取消的调用不会出现在 `pending` 里。
- **文档口径**：工具数 7→9、决策包字段表补 `callId`/`args`/`untrusted`、"7 个工具"改 9 个。

## [0.7.3] - 2026-11-06

> 0.7.3 与之前的 0.7.1、0.7.0、0.6.0、0.5.4 都还没有发布到 npm（npm 上仍是 0.5.3）。0.7.2 只存在于本机探针构建，从未入库。

- **新增 `approvals.mode=delegate`：把批准权交给派发方**。升权请求不再一律被拒，而是被挂起；调用方用 `dsh.approvals.pending`（可 `waitMs` 长轮询 ≤120 秒）读出"要执行的确切命令、工作目录、当前预设、模型给的理由、到期时间"，再用 `dsh.approvals.resolve` 回答 `allow-once` 或 `reject`。MCP 侧对应 `dsh_approvals_pending` / `dsh_approvals_resolve`。
- **没人回答就是拒绝**：`approvals.deadlineMs`（默认 60000）到期把挂起的调用判为拒绝，绝不自动放行。宿主自己的审批服务没有超时——这正是过去 10 分钟挂死的成因——所以超时由桥负责。
- **`allow-once` 按会话计次，上限 3 次**：宿主没有"允许一次"的接口，桥手上唯一的杠杆是会话级 permission preset，所以放行等于放宽该会话。护栏是每会话最多 3 次、只接受 `workspace-write` 与 `danger-full-access` 两档、其余不询问直接拒；次数用尽后一律拒绝。
- **`/status` 的 `calls` 新增 `approvals.allowed`**：与 `approvals.denied` 并列，用来判断无人值守会话是否真的在用这条通道。
- **决策包报告会话当前的预设**：`preset` 从宿主会话的权限服务读出（原来读一个不存在的字段，恒为 null），读不到时为 null 且不影响判定——派发方要判断"升到哪一档"，必须先知道现在在哪一档。
- **调用被取消时待批请求立刻收回**：挂起期间轮次被取消或调用方断开，这条请求从 `dsh.approvals.pending` 里消失并按拒绝处理——不会留下一个事后还能批准的悬空条目。
- **`approvals.deadlineMs` 的非法值报错而不是静默修正**：`mode` 与 `deadlineMs` 一起校验，写错就抛 `ConfigError` 并点名 `approvals`。

## [0.7.1] - 2026-11-06

> 0.7.1、0.7.0、0.6.0、0.5.4 都还没有发布到 npm（npm 上仍是 0.5.3）。0.7.0 没有发出去，因为它的实现挂错了钩子（见第一条）。

- **新增 `approvals.mode`（`off` 默认 / `deny`）**：桥创建的会话没有人在 GUI 前面，模型一旦请求升权（`sandbox_permissions`），宿主会把这次调用挂起等人回答——而没人可答。实测两次都是 `approval/asked` 之后毫无下文，调用方在 120 秒预算上超时。`deny` 在 `tools/pre-execute` 上挂前置 gate，把这类调用**在派发前**拒掉并说明原因，模型立刻知道"不行"，可以在这一轮里写完报告。它**只收紧权限、不放宽**：不升权的调用不受影响，不是本进程创建的会话一律放行给它们自己的应答者。
- **修正：`deny` 不能挂在 `approval/request` 上**（0.7.0 的错误）：审批服务经 `scopeTarget(req.agent, req.agent)` 派发，只走到该 agent 自己组合里的应答者。实测在插件上下文与 root 上下文各注册一次，真实升权时监听器一次都没被调用（GUI 面板仍在等）。改用全局 waterfall `tools/pre-execute` 后才真正生效。
- **`/status` 的 `calls` 新增 `approvals.denied`**：被桥拒绝的升权次数单独计数，不与调用结果混在一起——它不由任何一次调用产生，但能从这颗数字看出无人值守会话是否真的撞墙。
- **配了不认识的值就报错**：`approvals: { mode: "allow" }` 这类拼写错误在启动时抛 `ConfigError` 并点名 `approvals`，不静默退回 `off`（否则运维会以为拒绝生效了，实际仍在挂）。

## [0.6.0] - 2026-11-06

> 0.6.0 与 0.5.4 都还没有发布到 npm（npm 上仍是 0.5.3）。

- **调用方断开后不再继续空跑**：`/dsh-rpc` 的非流式请求在 socket 关闭时中止本次调用。中止只停事件迭代、释放槽位，**不终止**那一轮——它仍在 Host 里跑，之后可以用 `wait` 收回来。这是 abort 而不是 cancel，两者必须分开。
- **MCP 的 `notifications/cancelled` 真的生效了**：`tools/call` 进行中收到取消通知会中止对应请求（按客户端 request id 建表）；未知的 request id 是 no-op，不崩、不回复。
- **`/status` 把"等超时"和"没人听"分开**：`calls.outcomes` 新增 `timeouts` 与 `cancelledByClient`。两者都不算失败调用，但从这两个数能看出是桥慢还是调用方已经走了。
- **独立审计（kimi-k3.1-pro）后的四处收窄**：被中止的调用不再同时计入 `errors`（原来"调用方走了"既算结局又算故障，错误率把正常离开当成了桥的错）；batch 在调用方断开后不再继续派发剩余成员，所有写响应分支统一了"已销毁/已结束就不写"的守卫；MCP 的在途表改为记住"这个 id 当初登记的是哪个 controller"，晚完成的旧请求不会删掉复用同一 id 的新请求的控制器——否则针对新请求的取消会静默失效；调用结束后从调用方的 `AbortSignal` 上解绑内部监听器。四条都配了会变红的守门用例。

## [0.5.4] - 2026-11-06

- **片长默认从 240 秒降到 120 秒**：唯一实测过的传输故障都在 300 秒以上（303.9 秒 `fetch failed`），90 秒与 120 秒的余量都已饱和（loopback 上单片开销实测 8–21 ms），所以取 120 秒——留 180 秒余量、与 10 分钟默认预算整除、边界更少。
- **片长上限变成硬钳制**：配置超过 `MAX_WAIT_SLICE_MS`（240000）会被钳到上限而不是被接受，启动时用 `log.warn` 说明；`dsh.discover` 在发生钳制时额外返回 `maxWaitSliceMsRequested`，让运维看得出"配的是多少、实际用的是多少"。低于 1000 的值同样钳到 1000。
- **客户端的片长提示也钳到同一上限**，传输预算 `slice + 30 s` 另外封顶 280000，保证任何路径下都不会把单个请求送到 300 秒的铡刀前。
- **截止不再只靠中止**：每读一帧事件都与本次运行的截止赛跑，宿主不再交还控制权时，答案仍由我们自己的预算写出（现场那次 `wait` 跑了 13 分钟就属这一类）。中止本身是协作式的，只能唤醒"正在等下一帧"的宿主，唤不醒"根本没在等"的。
- **清理不再能拖住答案**：`finally` 里对宿主事件流的 `return()` 改为有界等待（1 秒）。它原来是无界 `await`——运行已经算完、答案却卡在自己的收尾里，这正好是那 13 分钟的直接成因。
- **独立审计后的四处收窄**：片长与预算提示改用 `Number.isInteger`（浮点参数原来会让 `AbortSignal.timeout()` 抛 `RangeError`，请求一个都没发出去就崩了）；MCP 阻塞路径的传输预算与客户端统一封顶 280000；有界清理在流正常关闭后立刻 `clearTimeout`，不再留一个已 unref 的定时器；`turn/end` 与截止同时到达时以帧为准，不把真实完成报成 `timeout`（防御性：现有控制流下定时器回调不与同步段交错，该组合不可达，取舍写在代码注释里）。
- **`waitedMs` 是墙钟**：尾片若不足 1000 ms 会被抬到下限，因此 `waitedMs` 可能比 `budgetMs` 多出最多 1 秒；`slices` 与实际请求次数一致。

## [0.5.3] - 2026-11-06

0.5.2 已合并、尚未发布。这一版补上它漏掉的一环：**`dsh.discover` 其实从来没有返回过 `config`**，而 MCP 的默认预算与提示正是从那里读的——于是"默认值只有一个来源"在实际部署里并不成立，客户端读到 `undefined` 就退回写死的 600000。现在 `discover` 返回 `config`，并由测试守着。

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
