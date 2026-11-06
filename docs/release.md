# 发版手册

给维护者看。使用者只需要 [README §6「安装与更新」](../README.md#6-安装与更新) 里的那一行命令。

## 0. 现在是什么状态

| 项 | 值 |
| --- | --- |
| npm 上最新 | `0.7.7`（`npm view @punchact/dsh-rpc-agent version`；注册表刚更新时 `npm view` 可能滞后一两分钟，**以直查 `registry.npmjs.org` 为准**） |
| 注册表里有的版本 | `0.4.3`、`0.4.4`、`0.5.3`、`0.7.6`、`0.7.7` |
| 已撤回、取不到 | `0.4.1`、`0.4.2`（早期发布流程的失败版本，24 小时内 `npm unpublish` 掉的） |
| 未单独发布 | `0.5.4`、`0.6.0`（内容随 `v0.7.6` 一起交付，没有各自的 tag） |
| tag / Release | `v0.5.3`、`v0.7.6`、`v0.7.7` |

> 一版一个 Release、一个 tag。Release 一旦 Publish 就会触发发布，所以**不要把"写正文"当成创建 Release 的理由**（见 §2）。

## 1. 一次性准备（已完成，留作记录）

1. **npm 账号**：`npm whoami` 能返回用户名。作用域 `@punchact` 必须属于这个账号（同名用户或同名 org），
   否则发布会以 `E403` 失败——名字归谁，不看你的仓库叫什么。
2. **发布凭证**，两条路，工作流都认：

   **① Trusted Publishing（OIDC）——已配置，主路径。** npmjs.com → 本包 → Settings → Trusted Publisher
   里应有这一条：

   | 字段 | 值 |
   | --- | --- |
   | Organization or user | `Punchact` |
   | Repository | `dsh-rpc-agent` |
   | Workflow filename | `release.yml` |
   | Allowed actions | 必须包含 `npm publish`（新配置默认只允许 `npm stage publish`） |

   三条容易踩的规则：工作流要有 `permissions: id-token: write`；仓库里**不该**出现长期 token；新建的
   信任关系**必须在 2 天内完成一次成功发布**，否则过期且不可编辑，只能删掉重建。npm 保存这张表时不校验
   任何字段，填错了只在真正发布那一刻才报错。

   **② Granular token（兜底）**：Access Tokens → Generate New Token → **Granular Access Token**，权限
   read/write，**必须勾「bypass 2FA」**（npm 全站强制 2FA，普通令牌一律 `E403`；而且这个选项只能在创建时
   选，事后改不了）。放 `~/.npmrc`（本机手动发）或存成仓库 secret `NPM_TOKEN`（CI 兜底）。

3. **本机不要留着过期的 bypass token**。它是可以发布、但不能 `unpublish` 的一类凭证；过期或不再使用就
   去 npmjs.com 撤销，别只从磁盘删掉。

## 2. 发版

### 2.1 发版前

```bash
# 1. 版本号：三处必须一致（package.json / lib/version.mjs / package-lock.json 的两处）
#    npm run check:version 会拦第一对，check-package 不查 lock，所以抬版本时三处一起改
node -e "…"            # 见上一版的实际做法：用一次性脚本改 lock，别手改

# 2. CHANGELOG：顶部加一节 ## [x.y.z] - YYYY-MM-DD，写清「新增 / 修复 / 说明」
#    未发布的版本要在这一节里注一句「本版尚未发布到 npm（npm 上仍是 …）」

# 3. 本地全绿
npm run check:version
npm test               # 十段共 182 例
npm run check:package  # 向 npm 要真实打包清单再核对

# 4. 常规 PR 流程合进 main
```

### 2.2 A. GitHub Release（推荐，走 OIDC）

```bash
# 1. main 上打 annotated tag 并推（tag 名 = v + package.json 的 version，这是 release.yml 的第一道断言）
git tag -a v0.7.7 -F <说明文件>
git push origin v0.7.7

# 2. 在 GitHub 上建 Release —— 选 Draft，把正文按 §3 的模板写好
# 3. 核对无误后 Publish —— 这一步才真正触发发布
```

Draft 状态**不会**触发工作流，所以写正文是安全的：先存 Draft、反复改、最后 Publish。
工作流按 `release: published` 触发，tag 与版本号不一致、或 `check:version` / 单测 / 真宿主集成 / 打包检查
任何一项红，都不会进 publish。publish 用 OIDC 换短期凭证，仓库里没有可被盗的令牌。

只想演练不发布：Actions → release → Run workflow，`dry_run` 保持默认 `true`。它会跑完整 `verify` 并打印
`npm publish --access public --dry-run` 的真实清单。若这个版本号已经在注册表上（比如对着已发布的提交重跑
演练），工作流会先查 `registry.npmjs.org/@punchact%2Fdsh-rpc-agent/<version>`，命中 200 就直接给出
`::notice::version … already exists` 并结束——npm 那句 "You cannot publish over the previously published
versions" 对重跑演练是正常状态，不是缺陷。想真正演练打包结果，改版本号再跑。

### 2.3 B. 本机令牌发布（OIDC 出问题时的兜底）

```bash
npm publish          # publishConfig 已声明 access: public，不需要 --access
```

`prepublishOnly` 会先跑 `check:version`、十段单测与 `check:package`，检查不过就上传不了，也就不会白白占掉
一个版本号。用令牌发布的版本**没有 provenance**（见 §6）。

### 2.4 C. 发布认证失败时怎么定位

`npm publish` 把所有认证问题压成同一句 `ENEEDAUTH`，它分不清「没有 Trusted Publisher 条目」和「条目在但
工作流文件名对不上」。所以工作流准备了两个诊断开关，默认都关，只在需要时手动开：

| 输入 | 作用 | 怎么读结果 |
| --- | --- | --- |
| `diagnose` | 拿 GitHub 的 ID token 直接问注册表 `…/oidc/token/exchange/package/@punchact%2Fdsh-rpc-agent`，并打印 ID token 里的 `repository` / `repository_id` / `workflow_ref` 等声明 | `exchange status: 201` = 信任关系通了；`404 package not found` = 这个包名在 npm 上没有任何条目（或条目指向别的仓库）；`422` = 条目在但声明对不上 |
| `stage` | 走 `npm stage publish`，这是 Trusted Publisher **总是允许**的动作 | 暂存成功 = 条目匹配；仍 `ENEEDAUTH` = 条目根本不存在或工作流不匹配 |

用法：Actions → release → Run workflow 选**同一个 ref**，`dry_run=true`、`diagnose=true`，看 `oidc exchange
probe` 那一步的输出。**不要**把这些开关当成常规流程的一部分——健康的发布从里面学不到东西。

另一个高频坑：`actions/setup-node` 只要收到 `registry-url` 就会往 `~/.npmrc` 写
`//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`。没配 `NPM_TOKEN` 时那是个**空令牌**，npm 会判定
「凭证不可用」直接 `ENEEDAUTH`，**根本走不到 OIDC 交换**。所以 publish job 不写 `registry-url`，只在
`NPM_TOKEN` 非空时自己写 `~/.npmrc`。

## 3. Release 正文模板

正文固定四节，按这个骨架写；数字必须能从仓库或注册表复核（写不出数字的条目就不写）。

```markdown
## 变更

- 一句话说清这一版**为谁解决什么问题**（不是"重构了一下"）。
- 破坏性变更单独列一条，写清调用方要改什么。

## 说明

- 为什么这么改（根因、被否掉的替代方案、为什么它不够）。
- 已知边界：这一版**没**解决的、只在特定条件下成立的。

## 验证

- `npm test`：十段共 182 例（列出各段数字）。
- 变异验证：把某处改坏 → 哪条用例变红（写清"哪处、哪条"）。
- `check:version` / `check:package` 的实际输出（文件数、unpacked 大小）。
- 真宿主验证（若有）：一句话结论 + 会话 id 前 8 位。

## 安装

`dsh plugin add @punchact/dsh-rpc-agent`（或钉版本 `@x.y.z`）。
```

写正文的三条纪律：

1. **不写调试叙事**。"连着两次失败我先把责任归到…"这类过程留在 PR 与 issue 里，Release 只留结论与证据。
2. **每个结论都要能被第三方复核**：给注册表查询、给执行过的命令、给能算出来的数字。写不出就降级成"未验证"。
3. **格式与上一版一致**：同一套四节标题、同样的表格形状。读者是按位置找东西的。

`v0.7.6` 与 `v0.7.7` 的正文都是按这个骨架写的，可以直接对照。

## 4. 发布后核对清单

```bash
# 1. 注册表（直查，别只信 npm view 的缓存）
curl -s https://registry.npmjs.org/@punchact%2Fdsh-rpc-agent | \
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);console.log(p['dist-tags'], Object.keys(p.versions), p.versions[p['dist-tags'].latest].dist.shasum, p.versions[p['dist-tags'].latest].dist.unpackedSize)})"

# 2. provenance（OIDC 发布才有）
curl -s "https://registry.npmjs.org/-/npm/v1/attestations/@punchact%2Fdsh-rpc-agent@<版本>" | \
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).attestations.map(a=>a.predicateType)))"
```

- [ ] `dist-tags.latest` 指向新版本，`versions` 里能看到它
- [ ] `shasum` / `unpackedSize` 与 `check:package` 的输出对得上
- [ ] attestations 里有 `npm publish/v0.1` 与 `https://slsa.dev/provenance/v1`
- [ ] Release 页的正文与 §3 模板一致，tag 指向 `main` 上的合并提交
- [ ] README 顶部的「版本」一行改成新版本
- [ ] 本机 profile 换装后再冒烟一次：

  ```powershell
  plugin_manager({ action: "remove_bundle", target: "@punchact/dsh-rpc-agent" })
  plugin_manager({ action: "install_bundle", target: "@punchact/dsh-rpc-agent@<版本>" })
  node bin/dsh-rpc.mjs ping
  node bin/dsh-rpc.mjs ask "只回复两个字：收到" --cwd . --json
  ```

  `install_bundle` 若报 `already-installed`，先 `remove_bundle` 再装；装完 `~/.dsh/dsh-rpc/endpoint.json` 的
  `version` 才是新版本。

## 5. 这个包在 npm 上"完整"吗

`npm run check:package` 是这条流水线的守门人：它向 npm 要到**真实会被打包的文件清单**，然后

- 逐个核对 `main` / `exports` / `bin` / `icon` / `dsh.bundle.patch` 指向的文件都在包里；
- 顺着每个 `.mjs`/`.js` 的相对 `import` 走一遍，确认被引用的文件也在包里；
- 确认 `test/`、`scripts/`、`node_modules/` 没有混进去。

之所以专门写它：`files` 少一项不会让安装报错，只会让宿主在 `import` 那一刻失败，而那种失败在用户眼里
就是"设置里没有这一页"。

同一条命令还顺手断言了两件事：`package.json` 里**没有** `"private": true`、`publishConfig.access` 是
`"public"`。这两项 `npm publish --dry-run` **不会**替你检查（实测：带着 `private: true` 跑 dry-run 仍然
exit 0），而真正的拒绝发生在正式发布会——也就是打完 tag 之后。

## 6. 不可逆的地方

- **版本号发出去就收不回**。`npm unpublish` 有 24 小时与依赖数限制，正常路径是发新版本。0.4.1 / 0.4.2
  就是 24 小时内撤回的，代价是版本号永久作废——不要拿它做试验田。
- **provenance 只在「OIDC 发布 + 公开仓库 + 公开包」三条同时成立时才有**。仓库已于 2026-11-05 转为公开，
  0.4.4 起由 OIDC 发布的版本自动带上来源证明，工作流里刻意不写 `--provenance` 参数——npm 自己会加，
  私有仓库下加它反而会被拒绝。用令牌兜底发布则永远拿不到 provenance。
- **发到 npm 即公开**。仓库可以私有，包不行（私有包需要 npm 付费组织）。
- **Release 一旦 Publish 就会发布**。要改正文就停在 Draft；已经发布之后只能改 Release 正文，不能再改
  包内容。
