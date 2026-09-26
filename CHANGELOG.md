# Changelog

## 0.5.1 — 改名 dsh-guikit

- **包名 `sage-guikit` → `dsh-guikit`**。`cordis.patch.yml` 的 id / name 与
  `lib/index.js` 的 `export const name` 同步跟进——三者不一致会崩在 readiness 之前。
- **环境变量与缓存目录跟进改名**：`SAGE_GUIKIT_DIR` → `DSH_GUIKIT_DIR`，
  `%TEMP%\sage-guikit` → `%TEMP%\dsh-guikit`。⚠️ 这是 **breaking change**：若你显式设过
  旧变量，升级后会被忽略并回落到默认目录。缓存可再生，无数据损失。
- keywords 补 `dsh-plugin` / `deepseek` / `cordis` / `computer-use` / `uiautomation` 等。
- 脱敏：清掉 README 与 NOTICE 里的真名署名、CHANGELOG 里的开发机绝对路径。

## 0.5.0

从 cua-driver（DSH 官方实验性 computer-use 插件）偷来的两样，都补在 guikit 的短板上。

- 新增 **`gui_verify`**：语义验证。一条谓词（`mode=element` 断言某个 UIA 元素存在，可选
  再要求 `enabled` / `valueEquals`；`mode=window` 断言某窗口存在，可选再比对 bounds），
  连续 `stableSamples` 次都成立才算 `satisfied`，否则一直轮询到超时。
  返回值是 **`satisfied` / `unsatisfied` / `unknown`** 三态——
  `unknown` 表示「判不出来」（目标窗口不在、UIA 树遍历不穷尽），**绝不能当成功读**。
  照抄 cua 的一条原则：**缺席不可证明**，所以 `exists:false` 直接拒绝。
  实测五例：命中= satisfied（tries=2, streak=2）、窗口不存在= unknown、
  元素不存在= unknown、bounds 差 10011px= unsatisfied 且报出精确 delta。
- **输入类工具回执带 `delivery` 字段**（`gui_click` / `gui_drag` / `gui_type` / `gui_key` /
  `gui_scroll`）：`{sent:true, verified:false, note}`。起因是 2026-09-25 实测到
  「点击回执 ok 而界面纹丝不动」——Chromium 丢后台 PostMessage、合成光标被实时抢走，
  调用方从回执里看不出。现在「未验证」是返回值的一部分，要结论就必须跟一次 `gui_verify`。
  只读类工具（`gui_screen` / `gui_uia` / `gui_verify` 等）不挂这个字段。
- `gui_click` 回执补 `requested:{x,y}`，与落到实处的 `x,y` 并排——两者不一致时一眼可见。

## 0.4.0

- **换协议：MIT → Apache-2.0。** 代码一行没改，功能与 0.3.0 完全相同。
  换的理由是 Apache-2.0 多两样东西：第 3 条的**专利授权**，和第 4(d) 条的
  **`NOTICE` 必须随下游分发保留**——后者 MIT 没有，别人 fork 走可以合法地把署名删干净。
  配套动作：`LICENSE` 换成 Apache-2.0 全文、新增 `NOTICE`（`Copyright 2026 Bowen Zheng (gezi-wen)`）、
  `package.json` 的 `license` 字段与 `files` 白名单（加入 `NOTICE`，否则它不会进 npm 包）。
  ⚠️ 对你有没有影响：**再分发时要多带一份 `NOTICE`**，其余使用方式不变。
  （0.3.0 及更早的版本仍是 MIT，已发布的版本协议不会追溯变更。）

## 0.3.0

- 新增 **`gui_drag`**：按住拖动（选文字、拖窗口标题栏、拉滑块滚动条、拖放）。移动是插值发出的
  `SendInput` 绝对坐标（`MOUSEEVENTF_VIRTUALDESK`，多屏负坐标安全）——只调 `SetCursorPos`
  不产生拖拽事件，多数程序不认。`try/finally` 保证无论成败都松开按键，不会卡住鼠标。
  实测：拖 DPI-aware 窗口标题栏，请求 (160,90) → 实际 (159,90)。
- 新增 **`gui_window_shot`**：单窗口截图。走 `PrintWindow`，**窗口被别的窗口盖住也照样抓到它自己的内容**，
  而且不激活、不移动任何东西（同类方案的窗口截图会抢前台）。返回 `x/y` 原点与 `scale`，
  换算 `屏幕坐标 = 原点 + 图坐标 × scale`。实测 DSH 窗口 2584×1464 的 PNG 只有 298 KB，整屏那张是 8.8 MB。
  `scale` 是给 DPI-unaware 窗口用的：它们的 `GetWindowRect` 给物理尺寸，但 PrintWindow 按逻辑尺度渲染，
  图片内容只铺在左上角，没有这个数就会点错位置。
- 修复：**DLL 编译缓存不再用固定版本号**，改成 C# 源码的内容哈希。原先固定 `v2` 且只查文件是否存在，
  加了新方法后会加载到旧 DLL，报「U32 不包含名为 X 的方法」（这次加 PrintWindow 时踩到了）。
- 撤销 0.2.2 对 peer 范围的收紧：`@deepseek-ai/dsh-tools` 回到 `*`。原因是插件目录用的是
  「junction 桥」——peer 由 DSH 安装闭包提供，写死范围反而会挡住闭包版本（semver 预发布规则下
  `>=0.1.0-rc.1` 够不到 `0.1.5-rc.1`），逼出第二份 dsh-tools。
- 开发挂具：`smoke.mjs` 补窗口截图 / 窗口列表用例；新增 `smoke-drag.mjs` 做拖拽端到端。

### 一个非显然的约束（写在这里免得下次又撞）

窗口截图**不能**塞进 `gui_screenshot` 的脚本里。那样「按标题找窗口 + GetWindowRect + PrintWindow +
画网格」凑成一段胖脚本，Windows Defender 会经 AMSI 判定为恶意脚本**直接拒绝执行**
（「此脚本包含恶意内容，已被防病毒软件阻止」），稳定复现 3/3。拆成独立工具并压瘦脚本后不再触发。

## 0.2.2

- 收紧 peer 范围：`@deepseek-ai/dsh-tools` 从 `*` 改为 `>=0.1.0-rc.1`。
  原因是 npm 把 `*` 解析到 `latest` 标签，而那个标签还停在远古的 `0.0.1-rc.1`——
  裸装会拉进一份过老的 dsh-tools 盖住 DSH 自带的那份。
  ⚠️ **0.3.0 已撤销这个改动**：对「junction 桥」部署方式是错的，见上。

## 0.2.1 — 首次发布到 npm

- **修复：中文界面文本回传乱码。** 子进程在没有控制台时（DSH 的 spawn 就是这种），.NET 的
  `[Console]::OutputEncoding` 会回退到系统 ANSI 代码页（中文 Windows = gb2312），
  PowerShell 于是把 GBK 字节写进 stdout，而宿主按 UTF-8 解码——UIA 元素名、窗口标题里的中文
  全部变成 U+FFFD，ASCII 部分正常所以很隐蔽。现在 PRELUDE 第一句就把 stdout 钉死成 UTF-8。
- **修复：硬编码的本机路径。** 截图与编译缓存目录原本写死一个开发机绝对路径，
  换台机器直接失败。改为 `%TEMP%\dsh-guikit`，可用环境变量 `DSH_GUIKIT_DIR` 覆盖；
  子进程 cwd 同步跟随该目录（cwd 不存在会让 spawn 直接 ENOENT）。
- 补齐 `engines`、`repository` / `homepage` / `bugs`，加 MIT LICENSE 与中英双语 README。

## 0.2.0 — 未发布

精度与稳定性版本：`gui_uia` 结构化定位（tree / find / invoke / value）、
`gui_screenshot annotate`（坐标网格 + 光标十字准星）、`gui_wait` 轮询验证、
`gui_scroll`，共 9 个工具。

## 0.1.0 — 未发布

六个基础工具：`gui_screen` / `gui_screenshot` / `gui_click` / `gui_type` / `gui_key` / `gui_window`。
