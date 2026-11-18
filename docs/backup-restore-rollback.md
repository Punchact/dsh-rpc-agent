# 任务中心备份、恢复与回滚指南（0.9.0）

## 1. 状态库位置

当 `tasksEnabled: true` 时，任务中心全部持久状态（15 张表）保存在本机单个 SQLite 库中（开启 `WAL` 与 `foreign_keys=ON`）：

- **默认路径**：`$DSH_HOME/storages/task-center/tasks.db`（Windows 默认即 `%USERPROFILE%\.dsh\storages\task-center\tasks.db`）
- **伴随文件**：同目录下的 `tasks.db-wal`（预写日志）与 `tasks.db-shm`（共享内存索引）
- **自定义路径**：若配置了 `config.tasksDbPath`，以该路径及同前缀 `-wal` / `-shm` 为准

> [!WARNING]
> **不要在宿主运行且 `tasksEnabled: true` 时直接 `copy` / `cp` 正在写入的 `tasks.db`**——只拷贝主文件而漏掉或错位 `-wal` 会导致恢复出的库损坏或丢失最近提交的事务。

---

## 2. 热备份方法

推荐以下两种任选其一（备份期间不会损坏 WAL）：

### 方法 A：用 SQLite 在线备份命令（无需停机）

```powershell
$db = "$env:USERPROFILE\.dsh\storages\task-center\tasks.db"
$bak = "$env:USERPROFILE\.dsh\backups\tasks-$(Get-Date -Format 'yyyyMMdd-HHmmss').db"
New-Item -ItemType Directory -Force -Path (Split-Path $bak) | Out-Null
sqlite3 $db ".backup '$bak'"
```

`.backup` 会由 SQLite 引擎加读锁并把 WAL 中已提交的页一并合入目标单文件。备份完成后可校验完整性：

```powershell
sqlite3 $bak "PRAGMA integrity_check;"   # 应输出 ok
```

### 方法 B：先停派发再停机冷备

1. 将 `cordis.patch.yml` 的 `tasksEnabled` 设为 `false` 并重启宿主（停止所有 5 秒 `drainEffects` 写入），或直接停止 DSH Host 进程；
2. 完整打包复制 `tasks.db`、`tasks.db-wal`、`tasks.db-shm`（三者必须同属同一时刻）；
3. 恢复完成后再改回 `tasksEnabled: true` 并重启宿主。

---

## 3. 从备份恢复

1. **停止 DeepSeek Harness Host 进程**，确保没有进程持有 `tasks.db` 或 `-wal`/`-shm` 锁。
2. **留存现场**：把损坏或待替换的 `tasks.db*` 整体移至临时归档目录（不要直接覆盖删除，便于事后核对未完结的外部任务）。
3. **放入备份**：把 `.backup` 生成的单文件复制为 `tasks.db`，确保目录内没有残留旧的 `tasks.db-wal` / `tasks.db-shm`。
4. **启动宿主并复核**：

```powershell
node bin/dsh-rpc.mjs tasks list --json
```

> [!CAUTION]
> **恢复后绝对不要自动重放已达终态的任务**：若备份时间点早于某次外部派发，`tasks.db` 里可能把该任务记录为 `running` / `dispatching` / `cancel_requested`，而外部执行方（Antigravity / Codex / DSH 会话）其实已经跑完或停机。恢复后请逐条核对这些非终态任务，必要时先跑只读 `pump` 或用 `dsh-rpc tasks reconcile <taskId> --observed succeeded|failed|cancelled` 手动收口，不要用新的 `idempotencyKey` 直接重投。

---

## 4. 回滚到 0.8.x（保留账本）

若需要将插件从 `0.9.0` 退回 `0.8.1`（或更早版本）：

1. 在 `cordis.patch.yml` 中先删去 0.9.0 新增的 `tasks*` 配置项（或保留 `tasksEnabled: false` 前将其清理干净，以免旧版如有严格校验报错）。
2. 卸载 0.9.0 并安装回 `0.8.1`：

   ```bash
   dsh plugin remove @punchact/dsh-rpc-agent
   dsh plugin add @punchact/dsh-rpc-agent@0.8.1
   ```

3. **保留 `$DSH_HOME/storages/task-center/tasks.db` 不动**——`0.8.x` 完全不知道该目录的存在，会原样忽略它，未来再次升级到 `0.9.x` 时历史账本仍可直接接续。
4. 重启宿主。

---

## 5. 回滚后验收（三条必须同时成立）

1. **旧 RPC / 会话链路可用**：`node bin/dsh-rpc.mjs ping --json` 返回 `0.8.1`，`dsh.sessions.list` 与基础 `dsh_ask` 正常应答。
2. **任务中心工具消失**：`dsh-rpc discover --json` 方法数回到 `17`，MCP `tools/list` 不再出现 `dsh_tasks_*` 或 `dsh_agents_*`。
3. **账本文件仍在**：`$DSH_HOME/storages/task-center/tasks.db` 字节大小与修改时间保持回滚前原样，未被清理或改写。
