# DSH 任务中心操作手册（0.9.0）

> 面向本机操作者与维护者。任务中心默认关闭（`tasksEnabled: false`），打开后由本插件托管 DSH 自身、Antigravity 与 Codex App Server 的异步长任务。

---

## 1. 一次性启用与生效验证

在对应 profile 的 `cordis.patch.yml` 中把开关写入 `@punchact/dsh-rpc-agent` 的 `config`（至少三行生效，外部适配器按需选配）：

```yaml
- insert:
    - id: dsh-rpc-bridge
      name: '@punchact/dsh-rpc-agent'
      config:
        tasksEnabled: true
        tasksMaxConcurrent: 1
        tasksExternalAdapter: none   # none | antigravity | codex
```

1. **重启 DeepSeek Harness Host** 使配置生效（首次开启会自动创建 `$DSH_HOME/storages/task-center/tasks.db` 并播种主体 `local-operator` 与本地工作区 `local`）。
2. **验证生效**：

```powershell
node bin/dsh-rpc.mjs discover --json        # 检查 config.tasksEnabled === true 且方法数包含 dsh.tasks.* / dsh.agents.*
node bin/dsh-rpc.mjs tasks list --json      # 返回 { items: [] } 即说明账本已就绪
```

---

## 2. 注册与探测一个执行方

所有执行方在注册时都必须提供 `capability-card@1` 能力卡，且 `limitations` 必须列出至少一条已知短板（空数组会直接报 `INVALID_CARD`）。注册完建议立即执行一次只读 `probe`。

### 三类执行方的卡片差异

| 执行方 | `identity.kind` / `adapterKind` | 必要配置项 / 注意事项 | 典型短板示例（`limitations`） |
| --- | --- | --- | --- |
| **DSH 自身（基准）** | `"dsh"` | `tasksEnabled: true` 时自动装配，无需 `tasksExternalAdapter`；可带可选 `projectId` | `["single-host session binding", "no unconfirmed hard-stop"]` |
| **Antigravity** | `"antigravity"` | `tasksExternalAdapter: "antigravity"`；通过守护进程 `hub_*.json` 发现 `httpPort`；在 `adapterConfig` / `projectId` 指定项目归属（映射为 `projectEnvConfig.projectId`），模型使用 `MODEL_PLACEHOLDER_*` | `["cascade resume after force-stop is session-sensitive"]` |
| **Codex App Server** | `"codex"` | `tasksExternalAdapter: "codex"`；走 `codex app-server --listen stdio://`；`tasksAdapters.codex.binary` 可显式指定 `codex.exe`（默认跳过 0 字节 `WindowsApps` 别名并回落 `.codex/.sandbox-bin/codex.exe`） | `["approval requires interactive stdio session"]` |

**注册与只读探测示例**：

```powershell
# dsh-card.json 示例
# {
#   "identity": { "agentId": "ag-dsh", "name": "DSH Baseline", "kind": "dsh", "version": "0.9.0" },
#   "controls": {
#     "start": { "support": "required", "evidence": "sessionController.create+prompt" },
#     "steer": { "support": "optional", "evidence": "prompt(mode=steer)" },
#     "cancel": { "support": "required", "evidence": "sessionController.cancel" },
#     "inspect": { "support": "required", "evidence": "list+follow snapshot" },
#     "approval": { "support": "required", "evidence": "approvalsStore" },
#     "events": { "support": "required", "evidence": "follow snapshot cursor" }
#   },
#   "limitations": ["cancel.stopped only true when host confirms stop"]
# }

node bin/dsh-rpc.mjs agents register --file ./dsh-card.json --json
node bin/dsh-rpc.mjs agents probe --agent ag-dsh --json
node bin/dsh-rpc.mjs agents list --verified-only --json
```

> [!NOTE]
> `probe` 只跑只读检查，永远不会在远端新建任务或发 prompt；若某控制项超时或不可达，对应项记为 `unknown`，整体 `probeStatus` 为 `partial` 或 `unknown`，`verified` 不会覆盖为 `true`。

---

## 3. 跑一个任务（`preview` → `submit` → `dispatch`，派发通常由机器侧代劳）

1. **生成一次性预览（`preview`）**：预览把请求摘要、工作区、目标执行方与能力修订（`capabilityRevisionId`，如基准 `review.diff@1`）绑定，默认 TTL 为 `tasksPreviewTtlMs`（`300000` ms）。
   - 查看 `degraded[]`：`dsh.tasks.preview` 与 `dsh.tasks.get` 会把该执行方声明为不支持（`"unsupported"`）的控制项列成 `{control, effect}`，`effect` 写明语义后果（例如 `cancel` 缺失时取消请求只会转 `needs_reconcile`）。要换执行方就趁现在。
2. **提交（`submit`）**：携带 `previewId` 与唯一 `idempotencyKey` 落盘，生成 `queued` 任务与 `stateVersion = 1`。
3. **派发（`dispatch`）**：开启 `tasksAutopilot`（默认 `true`）时这一步由宿主自己完成，下面的命令是手工兜底（自查、复现、或把自动环关掉之后用）。派发先受 `tasksMaxConcurrent` 原子并发门控检查，再将状态推至 `dispatching` 并调用 `adapter.start`；启动成功写入 `running` 与无密钥 `locator`，若启动抛错则立即转入 `needs_reconcile`（不会卡在 `dispatching`）。

```powershell
node bin/dsh-rpc.mjs tasks preview --principal local-operator --workspace local --agent ag-dsh --capability cap_review_1 --input '{"prompt":"检查最近改动"}' --json
node bin/dsh-rpc.mjs tasks submit --preview <previewId> --principal local-operator --capability cap_review_1 --workspace local --agent ag-dsh --idempotency-key job-20261119-01 --json
node bin/dsh-rpc.mjs tasks dispatch <taskId> --json
```

---

## 4. 跟进、查看事件、追加输入与审批

- **推进状态机（`pump`）**：

  ```powershell
  node bin/dsh-rpc.mjs tasks pump <taskId> --max-steps 50 --json
  ```

  每次 `pump` 有步数（`maxSteps`）和截止时间（`deadlineMs`）双上限：先拉取 `adapter.events(locator, cursor)` 并按 `adapterEventId` 去重写入账本，若无增量事件则调用一次 `adapter.inspect`；遇到未知状态或无 `attention` 的 `blocked` 报告时转入 `needs_reconcile`。

   > **谁在按按钮**：`dispatch` 与 `pump` 是机器侧动词，MCP 面刻意不暴露（外部调用方只有 8 个 `dsh_task_*` + 3 个 `dsh_agents_*`）。为了让经 MCP 提交的任务也能往前走，宿主自己跑一个有界推进环：每隔 `tasksAutopilotIntervalMs`（默认 `5000`ms）先按 `tasksAutopilotMaxStart`（默认 `2`）启动 `queued` 任务，再按 `tasksAutopilotMaxPump`（默认 `4`）逐个活跃状态（`dispatching`、`running`、`cancel_requested`、`waiting_input`、`waiting_approval`）推进一遍；单遍有步数与截止时间上限，上一遍没跑完时本遍直接跳过，失败只记录不中断。把 `tasksAutopilot` 置 `false` 就退回纯手工模式——此时经 MCP 提交的任务会一直停在 `queued`，直到有人执行 `tasks dispatch`。

- **查看当前状态、`phase` 与事件（`get` / `events`）**：
  - CLI 执行 `node bin/dsh-rpc.mjs tasks get <taskId> --json` 查看最新 `status`、`phase`、`stateVersion`、开放的 `attention` / `pendingApproval` 与最新事件摘要。
  - 若需按游标拉取完整账本事件窗口，在插件内或 JSON-RPC 层调用 `engine.events({ taskId, afterSeq })`（只读、递增 `seq`）。

- **向运行中任务补充输入（`input`）**：
  - 当任务处于 `running` 或 `waiting_input` 时，底层适配器通过 `sendInput(locator, { text })` 投递（DSH 走 `mode: "steer"`、Codex 走 `turn/steer`、Antigravity 走会话续发）。

- **回答待批操作（`approve`）**：
  - 当 `tasks get` 显示 `phase: "person/approval"`（且存在 `attemptId` 与 `approvalId`）时，用 CLI 或 `dsh.tasks.decideApproval` 裁决（该入口有意不暴露给 MCP）：

  ```powershell
  node bin/dsh-rpc.mjs tasks approve --task <taskId> --attempt <attemptId> --approval <approvalId> --decision allow --reason "已核对命令安全" --json
  # 拒绝则传 --decision deny
  ```

  `allow` 会映射为底层 `allow-once` 并将 `decide_approval` 副作用写入 `effects` 出箱队列；`deny` 映射为 `reject`。

- **取消任务（`cancel`）**：

  ```powershell
  node bin/dsh-rpc.mjs tasks cancel <taskId> --expected-version <stateVersion> --reason "取消本次检查" --json
  ```

  只登记 `cancel_requested` 与 `cancel` effect；只有拿到目标执行方的真状态机停机证据（而非 HTTP 200）才会变为 `cancelled`。

---

## 5. 人工核对（`needs_reconcile`）与收口语义

**何时进入 `needs_reconcile`**：
- `adapter.start` 抛出异常（`dispatch.failed`）或落盘前被并发取消抢先（`dispatch.orphaned`，保留 `locator` 供排查孤儿任务）。
- `cancel` effect 被执行方拒绝（`cancel.failed`）或执行方声明 `cancel.support === "unsupported"`（`cancel.unsupported`）。
- `pump` 收到未知状态或无结构化 `attention` 的 `blocked` 报告（`inspect.unknown`）。

**处理步骤**：
1. 先读取 `tasks get <taskId> --json` 里的 `locator` 与 `events`，去对应的真实宿主（DSH 会话、Antigravity UI 或 Codex 进程列表）**亲眼确认外部任务是已停、已失败还是其实跑完了**。
2. 用 CLI / `dsh.tasks.reconcile` 写入外部观测证据，一次性关闭仍标记 `side_effect_active = 1` 的旧 `attempt` 并推进任务态：

```powershell
node bin/dsh-rpc.mjs tasks reconcile <taskId> --observed cancelled --note "已在宿主侧确认级联停止" --json
# --observed 可选：succeeded | failed | cancelled
```

**引擎层 `resolve` 处置语义对照**（人工验收/终裁接口）：
- `accept`（→ `succeeded`）：接受当前产物并终态收口。
- `reject`（→ `failed`）：拒绝结果并终态收口为失败。
- `cancel`（→ `cancelled`）：确认作废并终态取消。
- `requeue`（→ `queued`）：仅在当前没有任何 `side_effect_active = 1` 的残留 `attempt` 时才允许重新入队（否则被状态机拒绝，防止双写并发）。

---

## 6. 排障速查

| 错误码（`error.data.kind`） | 含义 | 先查什么 |
| --- | --- | --- |
| `STATE_CONFLICT` | 状态迁移不合法、乐观锁 `expectedStateVersion` 过期，或触发 `tasksMaxConcurrent` 上限 | 跑 `tasks get <taskId> --json` 看最新 `status` 与 `stateVersion`；若 `data.reason === "max_concurrent"`，先 `tasks list` 看占用槽位的活跃任务 |
| `IDEMPOTENCY_CONFLICT` | 同一个 `(principalId, idempotencyKey)` 下传入了不同的请求参数 | 更换新的 `--idempotency-key`，或检查是否在重放旧命令时改了参数 |
| `ADAPTER_UNAVAILABLE` | 外部适配器未开启、二进制/守护进程找不到或调用失败 | 检查 `tasksExternalAdapter`、Antigravity `hub_*.json` 是否存活、或 Codex `codex.exe` 路径是否可读；若任务已进 `needs_reconcile`，先核对再 `reconcile` |
| `CONTROL_UNSUPPORTED` | 目标执行方能力卡声明不支持该控制项（如 `cancel.support === "unsupported"`）或超出当前能力约束 | 跑 `agents list --json` / `agents probe` 查看 `controls` 与 `limitations`；对不支持取消的任务走 `reconcile` 人工确认 |

---

## 7. 数据目录、热备份与回滚

SQLite 账本默认位于 `$DSH_HOME/storages/task-center/tasks.db`（WAL 模式伴随 `-wal` 与 `-shm`）。完整的停派发热备、恢复重放注意事项及回滚至 `0.8.x` 的验收步骤见：[backup-restore-rollback.md](./backup-restore-rollback.md)。
