# 发版手册

给维护者看。使用者只需要 [README §6「安装与更新」](../README.md#6-安装与更新) 里的那一行命令。

## 0. 现在是什么状态

| 项 | 值 |
| --- | --- |
| npm 上最新 | `0.9.4`（`npm view @punchact/dsh-rpc-agent version`；注册表刚更新时 `npm view` 可能滞后一两分钟，**以直查 `registry.npmjs.org` 为准**） |
| 注册表里有的版本 | `0.4.3`、`0.4.4`、`0.5.3`、`0.7.6`、`0.7.7`、`0.7.8`、`0.8.1`、`0.9.3`、`0.9.4` |
| 已撤回、取不到 | `0.4.1`、`0.4.2`（早期发布流程的失败版本，24 小时内 `npm unpublish` 掉的） |
| 未单独发布 | `0.5.4`、`0.6.0`（内容随 `v0.7.6` 一起交付，没有各自的 tag）、`0.8.0`（内容随 `v0.8.1` 一起交付）、`0.9.0`、`0.9.1`、`0.9.2`（内容随 `v0.9.3` 一起交付） |
| 仓库内锁定、未发布 | `0.9.5`（内部锁定；未打 tag、未建 Release、未 publish，npm 上仍以 `0.9.4` 为最新） |
| tag / Release | `v0.5.3`、`v0.7.6`、`v0.7.7`、`v0.7.8`、`v0.8.1`、`v0.9.3`、`v0.9.4` |

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
# 1. 版本号：三处必须一致（package.json / src/lib/version.mts / package-lock.json 的两处）
#    先 npm run build 再跑 npm run check:version 会拦第一对，check-package 不查 lock，所以抬版本时三处一起改
node -e "…"            # 见上一版的实际做法：用一次性脚本改 lock，别手改

# 2. CHANGELOG：顶部加一节 ## [x.y.z] - YYYY-MM-DD，写清「新增 / 修复 / 说明」
#    未发布的版本要在这一节里注一句「本版尚未发布到 npm（npm 上仍是 …）」

# 3. 本地全绿（仓库根目录是私有开发工作区，真实发布物是构建出的 `dist/` 产物包）
npm run build
npm run check:version
npm run check:types
npm test
npm run test:host
npm run check:package            # 向 npm 要 dist/ 真实打包清单再核对
node scripts/check-release-path.ts

# 4. 常规 PR 流程合进 main
```

### 2.2 A. GitHub Release（推荐，走 OIDC）

```bash
# 1. main 上打 annotated tag 并推（tag 名 = v + package.json 的 version，这是 release.yml 的第一道断言）
git tag -a v0.8.1 -F <说明文件>
git push origin v0.8.1

# 2. 在 GitHub 上建 Release —— 选 Draft，把正文按 §3 的模板写好
# 3. 核对无误后 Publish —— 这一步才真正触发发布
```

Draft 状态**不会**触发工作流，所以写正文是安全的：先存 Draft、反复改、最后 Publish。
工作流按 `release: published` 触发，两个 job 之间**不重建**：`verify` job 先 `npm run build` 生成 `dist/`，校验 tag、版本、`check:types`、全套单测、真宿主集成、`dist/` 打包与 `check-release-path`，然后把 `dist/` 打成 tarball（`npm pack ./dist`）、写出 `sha256sum` 并 `upload-artifact`；任何一项红都不会进 `publish`。`publish` job 只做三件事——`download-artifact` 取回那份 tarball、`sha256sum -c` 校验摘要、`npm publish "$TARBALL" --access public`（+ OIDC 换短期凭证，仓库里没有可被盗的令牌）。**发布物就是验证物**：publish 不再 checkout 源码重新构建，所以不会出现“验的是 Node 22 的构建、发的是 Node 24 的构建”这种两份字节。仓库根目录保留 `"private": true` 且无 `files` 字段，任何形式的根目录发布会直接失败。

只想演练不发布：Actions → release → Run workflow，`dry_run` 保持默认 `true`。它会跑完整 `verify`（含打包与上传 tarball），并在 `publish` job 下载那份 tarball、校验摘要后打印 `npm publish "$TARBALL" --access public --dry-run` 的真实清单。若这个版本号已经在注册表上（比如对着已发布的提交重跑
演练），工作流会先查 `registry.npmjs.org/@punchact%2Fdsh-rpc-agent/<version>`，命中 200 就直接给出
`::notice::version … already exists` 并结束——npm 那句 "You cannot publish over the previously published
versions" 对重跑演练是正常状态，不是缺陷。想真正演练打包结果，改版本号再跑。

### 2.3 B. 本机令牌发布（OIDC 出问题时的兜底，同样只发布 `dist/` 产物）

仓库根目录带有 `"private": true` 与指向 `./dist/...` 的工作区入口，**禁止**也不可能直接从仓库根执行 `npm publish`；本机发布与 CI 一样，先构建并整套验过，再发布 `dist/` 产物包（二选一）：

```bash
# 第一步：在仓库根完成构建与全部发布前校验
npm run build && npm run check:version && npm run verify

# 第二步（方式一）：进入 dist/ 发布产物包
(cd dist && npm publish)          # dist/package.json 已去除 private 并声明 access: public

# 第二步（方式二）：先打包成 tarball 再发布该压缩包
npm pack ./dist
npm publish ./punchact-dsh-rpc-agent-<版本>.tgz
```

以上校验不通过就不要进入第二步，也就不会白白占掉一个版本号。用令牌发布的版本**没有 provenance**（见 §6）。

本机兜底路径没有 artifact 绑定（那是 CI 的事），“发布物是验证物”靠你按第一步先跑 `verify` 来保证；想更接近 CI 的形态，用方式二先 `npm pack ./dist` 再发那个 `.tgz`。

**这条路径没有自动防呆，别指望 npm 帮你拦。** `dist/package.json` 的 `prepublishOnly` 由构建脚本剥掉了（它引用仓库根的 `scripts/`，产物包里没有），而仓库根的 `prepublishOnly` 因为 `"private": true` 永远不会被触发——所以 `(cd dist && npm publish)` 一旦敲下去就直接发。要么按上面第一步手工跑 `verify`，要么用 `npm run release:local`（先 `verify` 再 `npm pack ./dist`，产出的 `*.tgz` 已被 `.gitignore` 忽略）。

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

正文沿用 DeepSeek Harness 官方发布说明的写法：**中英双语、分类标题下一行一条、末尾给 Full Changelog 比较链接**。读者是扫一遍就想知道「这版给我什么」的人，不是来读设计的。

```markdown
[中文](#cn-x.y.z) | [English](#en-x.y.z)

<h3 id="cn-x.y.z">新增功能</h3>

- 一句话说清用户拿到什么，带参数名或最小示例；不为内部实现留篇幅。

### 体验优化

- 行为变化写这里：默认值、输出形状、提示时机。

### 升级提示

- 只在真有影响时出现：工具数或输出形状变了、桥与插件需同版本、怎么关掉新行为。没有就整节省略。

### 其他变更

- 文档、测试链、CI 之类，一句一条；不写数字（数字在 CHANGELOG 里）。

<h3 id="en-x.y.z">New Features</h3>

- 英文小节与中文逐条对应（`### Improvements`、`### Upgrade Notes`、`### Chores`），不要只译一半。

Full Changelog: https://github.com/Punchact/dsh-rpc-agent/compare/v<上一版>...v<本版>
```

写法要点：

- 分类按内容取用，没有的分类整节省略；第一个分类紧跟语言锚点出现。
- 锚点 id 固定 `cn-<tag>` / `en-<tag>`，开头那行 `[中文](#…) | [English](#…)` 不能省，双语读者靠它跳转。
- 一行一条、一句一个事实；不写「我」「我们」，不写调试叙事。
- **正文不写验证数字**（套件数、用例数、run 号、包体大小）：这些留在 CHANGELOG 与 PR，正文只靠末尾的 `Full Changelog` 链接把人送过去。
- 署名按 DSH 习惯可省（本仓库单一维护者），有多人贡献时再按 `@handle` 补。

写正文的三条纪律：

1. **不写调试叙事**。"连着两次失败我先把责任归到…"这类过程留在 PR 与 issue 里，Release 只留结论与证据。
2. **正文不背证据，证据放对地方**：套件数、用例数、run 号、注册表查询这类可复核的数字进 CHANGELOG 与 PR 正文，Release 只留结论与 `Full Changelog` 链接；§4 的发布后核对清单照旧要逐项给出可复核的结果。
3. **格式与上一版一致**：同一套中文与英文分类标题、同样的锚点行。读者是按位置找东西的。

`v0.8.1` 起按上面这套 DSH 风格写；`v0.7.7`、`v0.7.8` 是旧的四节写法（变更 / 说明 / 验证 / 安装），只作历史对照。

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
  $cli = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@punchact\dsh-rpc-agent\dist\bin\dsh-rpc.mjs"
  node $cli ping
  node $cli ask "只回复两个字：收到" --cwd . --json
  ```

  （迁移后包里唯一真实入口是 `dist/bin/dsh-rpc.mjs`；仓库根的 `bin/` 与 `index.mjs` 已不存在。）

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
