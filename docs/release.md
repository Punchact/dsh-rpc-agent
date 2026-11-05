# 发版手册

给维护者看。使用者只需要 §6「安装与更新」里的那一行命令。

## 一次性准备（已完成，留作记录）

1. **npm 账号**：`npm whoami` 能返回用户名。作用域 `@punchact` 必须属于这个账号（同名账号或同名 org），
   否则发布会以 `E403` 失败——名字归谁，不看你的仓库叫什么。
2. **发布凭证**，两条路，工作流都认：

   **① Trusted Publishing（OIDC）——已配置，主路径。** npmjs.com → 本包 → Settings → Trusted Publisher
   里已有这一条：

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
   read/write，**必须勾 "bypass 2FA"**（npm 全站强制 2FA，普通令牌一律 `E403`；而且这个选项只能在创建时
   选，事后改不了）。放 `~/.npmrc`（本机手动发）或存成仓库 secret `NPM_TOKEN`（CI 兜底）。

## 发版

### A. GitHub Release（推荐，走 OIDC）

```bash
# 1. 改版本，两处必须一致：package.json 的 version、lib/version.mjs 的 PLUGIN_VERSION
npm run check:version

# 2. 常规 PR 流程合进 main，打 annotated tag 并推
git tag -a v0.4.2 -F <说明文件>
git push origin v0.4.2

# 3. 在 GitHub 上建 Release（Published）—— 这一步才真正触发发布
```

`release.yml` 先跑 `verify`：tag 与 `package.json` 版本一致性、`check:version`、单元套件、真宿主集成
测试、打包内容检查；任何一项红都不进 publish。publish 用 OIDC 换短期凭证，仓库里没有可被盗的令牌。

只想演练不发布：Actions → release → Run workflow，`dry_run` 保持默认 `true`，它会跑完整 `verify` 并打印
`npm publish --access public --dry-run` 的真实清单。

### B. 本机令牌发布（OIDC 出问题时的兜底）

```bash
npm publish          # publishConfig 已声明 access: public，不需要 --access
```

`prepublishOnly` 会先跑 `check:version`、单元套件、`check:package`，检查不过就上传不了，也就不会白白占掉
一个版本号。

发布成功后：

```bash
npm view @punchact/dsh-rpc-agent version
npm view @punchact/dsh-rpc-agent dist-tags
```

## 这个包在 npm 上"完整"吗

`npm run check:package` 是这条流水线的守门人：它向 npm 要到**真实会被打包的文件清单**，然后

- 逐个核对 `main` / `exports` / `bin` / `icon` / `dsh.bundle.patch` 指向的文件都在包里；
- 顺着每个 `.mjs`/`.js` 的相对 `import` 走一遍，确认被引用的文件也在包里；
- 确认 `test/`、`scripts/`、`node_modules/` 没有混进去。

之所以专门写它：`files` 少一项不会让安装报错，只会让宿主在 `import` 那一刻失败，而那种失败在用户眼里
就是"设置里没有这一页"。

同一条命令还顺手断言了两件事：`package.json` 里**没有** `"private": true`、`publishConfig.access` 是
`"public"`。这两项 `npm publish --dry-run` **不会**替你检查（实测：带着 `private: true` 跑 dry-run 仍然
exit 0），而真正的拒绝发生在正式发布会——也就是打完 tag 之后。

## 不可逆的地方

- **版本号发出去就收不回**。`npm unpublish` 有 24 小时与依赖数限制，正常路径是发新版本。
- **provenance 只在「OIDC 发布 + 公开仓库 + 公开包」三条同时成立时才有**。所以现在（仓库私有）发布不会
  带来源证明，工作流里也没有 `--provenance` 参数——私有仓库下加它会被 npm 直接拒绝；仓库转公开后下一次
  OIDC 发布会自动带上，不用改代码。用令牌兜底发布则永远拿不到 provenance。
- 发到 npm 即**公开**。仓库可以私有，包不行（私有包需要 npm 付费组织）。
