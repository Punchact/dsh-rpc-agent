# 变更记录

## [Unreleased]

### 修复

- 审批 waterfall 不再因下游 listener 抛错而重调已消费的 continuation；权限恢复失败保留可恢复台账，并在 gate 关闭/恢复未完成时阻止新的放宽。
- 持久审批额度回滚、恢复欠账容量保留及 dispose 生命周期按真实持久状态后端处理。
- 粘性会话复用应用请求的会话选项；同项目并发首次 ask 共享会话创建；注册表并发更新使用串行写入和唯一临时文件。
- 客户端合并取消与超时预算、检查 HTTP/JSON-RPC 错误响应；MCP 完整返回轮次正文，支持通过 `since` 游标续读；CLI/MCP 参数及错误路径对齐契约。
- 发布诊断仅记录 HTTP 状态和白名单声明，不输出 OIDC token 或响应正文。

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
