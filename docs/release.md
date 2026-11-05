# 发版手册

给维护者看。使用者只需要 §6「安装与更新」里的那一行命令。

## 一次性准备

1. **npm 账号**：`npm whoami` 能用。作用域 `@punchact` 必须属于你（同名账号或同名 org），否则
   发布会以 `E403` 失败——名字归谁不看你仓库叫什么。
2. **Trusted Publishing**（推荐，之后不再需要 token）：npmjs.com → 本包 → Settings →
   Trusted Publishers → GitHub Actions，填

   | 字段 | 值 |
   | --- | --- |
   | Organization or user | `Punchact` |
   | Repository | `dsh-rpc-agent` |
   | Workflow filename | `release.yml` |

   填完不要往仓库里加 `NPM_TOKEN`。工作流用 OIDC 换短期凭证，环境变量泄了也发不了包。

不想配 OIDC 也能手动发，见下面的「手动兜底」。

## 发版

```bash
# 1. 改版本（两处，必须一致）
#    package.json 的 version、lib/version.mjs 的 PLUGIN_VERSION
npm run check:version

# 2. 常规 PR 流程合进 main，然后打 annotated tag
git tag -a v0.4.1 -F <说明文件>
git push origin v0.4.1

# 3. 在 GitHub 上建 Release（Published）—— 这一步才真正触发发布
```

`release.yml` 会先跑一遍 `verify`：tag 与 `package.json` 版本一致性、`check:version`、
单元套件、真宿主集成测试、打包内容检查；任何一项红都不进 publish。

发布成功后：

```bash
npm view @punchact/dsh-rpc-agent version
```

## 手动兜底

没有 OIDC 时，在能登录的机器上：

```bash
npm login
npm publish          # publishConfig 已声明 access: public，不需要 --access
```

`prepublishOnly` 会先跑 `check:version`、单元套件、`check:package`，任一失败就不发。

## 这个包在 npm 上"完整"吗

`npm run check:package` 是这条流水线的守门人：它向 npm 要到**真实会被打包的文件清单**，然后

- 逐个核对 `main` / `exports` / `bin` / `icon` / `dsh.bundle.patch` 指向的文件都在包里；
- 顺着每个 `.mjs`/`.js` 的相对 `import` 走一遍，确认被引用的文件也在包里；
- 确认 `test/`、`scripts/`、`node_modules/` 没有混进去。

之所以专门写它：`files` 少一项不会让安装报错，只会让宿主在 `import` 那一刻失败，而那种失败
在用户眼里就是"设置里没有这一页"。

同一条命令还顺手断言了两件事：`package.json` 里**没有** `"private": true`、`publishConfig.access`
是 `"public"`。这两项 `npm publish --dry-run` **不会**替你检查（实测：带着 `private: true`
跑 dry-run 仍然 exit 0），而真正的拒绝发生在正式发布会——也就是打完 tag 之后。

## 不可逆的地方

- **版本号发出去就收不回**。`npm unpublish` 有 24 小时与依赖数限制，正常路径是发新版本。
- **仓库私有期间不发 `--provenance`**：npm 的 provenance 需要公开可验证的源码仓库，私有仓库会被拒。
  `release.yml` 里按 `github.event.repository.private` 自动切换——仓库转公开后下一次发布自动带上。
- 发到 npm 即**公开**。仓库可以私有，包不行（私有包需要 npm 付费组织）。
