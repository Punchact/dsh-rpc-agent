import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function patch(relPath, oldText, newText) {
  const path = ROOT + relPath;
  const before = readFileSync(path, "utf8");
  const hits = before.split(oldText).length - 1;
  if (hits !== 1) {
    throw new Error(`${relPath}: expected exactly 1 anchor, found ${hits}`);
  }
  const after = before.replace(oldText, newText);
  writeFileSync(path, after, "utf8");
  const crlf = (after.match(/\r\n/g) ?? []).length;
  const bom = after.charCodeAt(0) === 0xfeff;
  console.log(`${relPath}: patched (bytes=${Buffer.byteLength(after)} crlf=${crlf} bom=${bom})`);
}

const designOld =
  "**决定**：①入口判定两侧都过 `realpathSync`，把 argv 与模块 URL 放到同一坐标系；" +
  "②参数只做**形状**判断，不做“合法值收窄”——值交给下游校验器原样拒绝；" +
  "③MCP 的 `arguments` 不是对象就直接 `-32602`，不再猜调用方想传什么。";

const designNew =
  designOld +
  "；④复查时又抓到同类的第四处：`dsh.tasks.preview` 收到非字符串 `requestDigest`（例如数字）会静默改用计算值，" +
  "等于把调用方“我预览的就是这个请求”的承诺丢掉，一并改成拒绝（回归在 `test/tasks-events-and-preview.test.mjs`）。";

patch("docs/design.md", designOld, designNew);

const changelogOld = "（决策见 `docs/design.md` §60、§61）。";
const changelogNew =
  "（决策见 `docs/design.md` §60、§61）。复查时又把同类的第四处补上：" +
  "`dsh.tasks.preview` 收到非字符串 `requestDigest` 时会静默改用计算值，等于丢掉调用方的绑定承诺，现改为拒绝" +
  "（回归 `test/tasks-events-and-preview.test.mjs`）。";

patch("CHANGELOG.md", changelogOld, changelogNew);
