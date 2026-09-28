# Changelog

## 0.6.1 — 文档：补全 `scale` 语义与混合缩放限制

**仅文档，零代码改动**：`lib/index.js` 与 0.6.0 逐字节相同（SHA256 `C9C56D7A6F95004B5DA587B7728D859BEDA8CE14CC6292598DA7DA4983DE393F`）。
发布这个小版本只为把一条容易被误判的边界写进 README，免得别人把正常行为当成 bug 去改。

- **README「已知边界」重写 DPI 那条**：原文只写了 `scale > 1`（DPI-unaware 情形），漏了 **DPI-aware 应用跑在缩放百分比与主屏不同的显示器上会得到 `scale < 1`**（实测主屏 175% + 副屏 200% ⇒ `0.875`）。现在三种取值（`=1` / `>1` / `<1`）连同各自的成因、现象与用法一次写清
- **新增「混合缩放下的截图裁切」限制**：位图画布按虚拟桌面空间分配、内容按窗口自身像素渲染，`scale < 1` 时右下被裁（实测整条播放条消失）、`scale > 1` 时右/下多出黑边。**只影响能看到多少，不影响坐标正确性**；要避开就把各显示器设成同一缩放百分比
- 这两条都是 2026-09-29 夜里的实测结论：当时曾误判 `scale` 公式有 bug 并改了它，随后用「金色高亮条像素测量 + 两次点击对照」证伪——**原公式正确，改动反而会引入 12.5%~14% 的系统性点偏**，已完整回滚（回滚后哈希回到 `C9C56D7A`）

## 0.6.0 — 坐标契约 + UIA 五态 + `gui_locate`

主线不是加功能，是**把三套坐标空间收敛成一条可自证的契约**：工具回带 `space`/`origin`/`scale`，
annotate 图里烧标尺与水印，新增 `gui_locate` 把「看图猜坐标」这个环节整体删掉。

- **Breaking（行为，非 API）**：`gui_uia` 遍历器由 `ControlViewWalker` 换成 **`RawViewWalker`**
  （`ControlView` 与 `FindAll(Descendants)` 只返回 `IsControlElement=true` 的元素——同一窗口两者都只有 **818**，
  而 RawViewWalker 有 **1578**，会漏掉非控件节点；且 RawView 的真实内容被中间层推深，
  有 **743** 个非控件元素落在 depth > 14），`depth` 默认 **10 → 40**、`max` 默认 **300 → 2000**
  （硬顶 **8000**），并新增**返回预算 `maxRows`（默认 120、硬顶 2000）**。
  ⚠️ `tree` 默认回带的 `elements` 行数因此从「最多 300」变为「最多 120 行」——
  这是有意的：本机 DSH 窗口 `RawView` 全树实测 1500+ 个元素（随窗口内容漂移，同一窗口不同时刻见过 1578 与 2450~2522），
  默认全量返回等于上百 KB JSON 灌进模型上下文。
  被 `maxRows` 截断时 `rows_truncated=true` 且带 hint。`count` 语义明确为「实际回带行数」，
  `matched`（匹配总数）/ `total`（遍历访问到的元素数）另列。
  **若你的代码按 `count == 0` 判断「不存在」，请改判 `status`。**
- **Changed**：`gui_uia` 返回的 `type` 现在是**短名**（`Button`），不再是 `ControlType.Button`。
  旧的 `-replace "^ControlType\\."` 因 JS → PowerShell 的转义退化**从未真正生效**——它曾把完整
  `ProgrammaticName` 原样回带；新的空壳判据需要真剥前缀。`elType` 过滤用子串匹配（`-like "*Button*"`），
  **两种写法的调用都不受影响**，所以按 Changed 而不是 Breaking。
- **Added**：第 13 个工具 **`gui_locate`**：给 `name`（必填）+ 可选 `window`（标题子串或 handle，
  缺省用前台窗口兜底；`title` 是等价别名——和 `gui_uia`/`gui_verify` 的叫法对齐，两者都给时 `window` 优先）/
  `elType` / `index` / `depth` / `max` / `timeoutMs`，直接用 UIA 返回**可喂给 `gui_click` 的虚拟桌面物理像素**
  `point{x,y}` + `rect` + `type` + `enabled` + `uiaPath` + `total`/`matched` + `space`/`origin`/`scale`。
  **绝不返回猜测坐标**：7 个状态里**只有 `status="found"` 给顶层 `point`**。状态集合比 `gui_uia` 更大：
  `found` / `ambiguous`（多命中且未给 `index` → 回 `candidates[]` 前 5 个候选，各带 rect/point/offscreen，
  离屏候选的 `point` 为 `null`）/ **`offscreen`**（元素存在但离屏，或中心在窗口 rect 外——先让它可见，
  **别点那个坐标**；实测本机 DSH 窗口有 1202/1297 个 Text 元素 `offscreen:true`、1130 个 y < −1000，
  这不是理论顾虑）/ `not-found`（遍历走完、确实没匹配）/ `not-exposed` / `inconclusive` / `truncated`。
  `index` 越界会**明确报错并给出 `validIndex` 区间**（不静默回落 0）；`timeoutMs` 给了就反复重走
  直到元素出现（250 ms 间隔；默认 0 = 单次）。
- **Added**：`gui_uia` 返回**五态 `status`**——`found` / `empty-but-accessible` / `not-exposed` / `inconclusive` / `truncated`，
  并回带 `total` / `matched` / `truncated` / `rows_truncated` / `depth_reached` / `walker` / `hints`。
  **只有 `empty-but-accessible` 允许读成「确实没有这个元素」**；另外三态分别是「换视觉路径」（`not-exposed`）、
  「人工判断：空窗口与 a11y 被藏分不清」（`inconclusive`）、「absence 未证明，去加预算」（`truncated`）。
  分流规则：遍历**自然走完**（未撞 `depth`/`max`）后看树的形状——有文本/可交互节点且无匹配 = `empty-but-accessible`；
  **零内容节点**（`textNodes == 0` 且无可交互控件）＝ 空壳，再按本次遍历访问到的节点数分：
  `total > 0` → `not-exposed`（有渲染面但没 a11y），`total == 0` → `inconclusive`（连面都没有）。
  该带 hint 的态都带（`hints` 数组 + `hint` 取第一条，状态类 hint 排在 `rows_truncated` 之前），
  `invoke`/`value` 也不再报误导性的「no element matching」。
- **Added**：`gui_click` / `gui_drag` 新增 `window`（标题子串或 handle）与 `space`（`virtual-desktop`（默认）| `window-local`）。
  `window-local` 时入参按 `gui_window_shot` 的图内像素解释，换算在 pwsh 内完成；
  回执新增 `space` / `origin` / `scale` / `requested` / `absolute` / `insideWindow` / `target`，窗口不存在直接报错而不是猜坐标。
  `gui_click` 的 `requested`/`absolute` 是**单点**；`gui_drag` 是 `{from,to}` **两点**，且 `insideWindow`
  要求起点与终点**都在**窗口内才为 `true`。
- **Added**：`gui_click` 新增可选 `verify`（参数与 `gui_verify` 逐个同名，含 `handle`/`exists`/`boundsX..H`/
  `tolerancePx`/`intervalMs`；该对象设了 `additionalProperties: false`）：
  点完在**同一进程内**立刻跑一次与 `gui_verify` 等价的断言，结果并进回执 `verify:{verdict,detail,observed,tries,streak}`。
  此时 `delivery.sent` 仍恒为 `true`，而 **`delivery.verified` 只在 verify 判定 `satisfied` 时为 `true`**
  （`unsatisfied` / `unknown` 保持 `false`，`delivery.note` 会写明这是工具内断言的判定结果、
  并点明只有 `satisfied` 才算 verified）。默认关。
- **Added**：坐标契约字段进回执。`gui_screen` 每屏加 `physical_rect` / `logical_rect` / `dpi_scale` / `is_primary` / `display_id`
  （逐屏 `MonitorFromPoint` + `GetDpiForMonitor`，取不到时 `dpi_scale`/`logical_rect` 为 `null`，不假装 1.0），
  顶层加 `virtual_desktop_origin` 与 `space`；`gui_screenshot` 加 `space` / `origin` / `image_px` / `scale` / `note`；
  `gui_window_shot` 加 `space:"window-local"` / `origin` / `image_px`（旧的 `x/y` 保留为别名）。
- **Fixed**：**annotate 标签与网格线不对齐**（0.5.x 实测递增偏差：240→195px、480→355px、720→515px，随坐标增大）。
  成因是网格、标签各自算一遍图内坐标。现在同一交点只算一次整数坐标、三处复用，并新增顶部/左侧**标尺**与
  **左下角水印**（`origin`/`space`/`scale`/`region`/`step` 烧进图里）——截图离开工具之后换算依据不再丢。
- **Fixed**：**`gui_uia` 截断不说**。0.5.1 的 `depth=10` + `max=300` 在同一 DSH 窗口直接撞上限却只回 300 行，
  看起来像「只有这些元素」。现在回带 `total`/`truncated` 两个数，并把默认预算提到实测够用的量级
  （`max` 硬顶提到 8000：真树有 2450~2522 个元素，硬顶停在 2000 会让「不存在」永远无法被证明）。
- **Fixed**：**`gui_verify` 的遍历器与 `gui_uia` 对齐**（同用 `RawViewWalker` + depth 40，共用同一段断言实现）。
  0.5.1 的 `gui_verify` 走 ControlView 且 depth 只有 14，在 Chromium/Electron 窗口上够不到文本节点，
  于是元素断言只能回 `unknown`（「判不出来」）。前后对照（同一断言、同一窗口）：
  `unknown`（5201 ms / tries=6）→ **`satisfied`（140 ms / tries=1）**。
- **Fixed（文档）**：更正「Electron/CEF 是 UIA 盲区」的旧结论——**取决于该应用有没有点亮 Chromium 的 a11y**。
  DSH 自己的 Electron 窗口裸 UIA 就有 470 个元素（RawView 1500+），而第三方空壳应用只暴露 4 行 Pane。
- **向后兼容**：所有旧字段名与旧参数名**全部保留**（`gui_window_shot` 的 `x/y`、`gui_uia` 的 `window`/`count`/`elements`、
  动作工具的 `x`/`y`/`result`/`fgTitle`/`fgHandle` 等），新增字段纯追加；`space` 不传时一律按 `virtual-desktop` 解释，
  旧调用行为不变。**唯一需要迁移的是**：把 `gui_uia` 的 `count == 0` 判据换成 `status`，
  否则会把 `not-exposed` / `truncated` 误当「不存在」；另外 `type` 由 `ControlType.Button` 变成 `Button`，
  按完整前缀做相等比较的代码要跟着改（子串匹配不受影响）。

### 已知限制（留到 0.6.1）

- annotate 大区域会**静默粗化 `step`**（面积 > 500 万像素且 `step` < 200 时改成 240），
  而**回执不自报实际步长**（只有图内水印写了）——程序化链路要拿到真实步长，请显式传 ≥ 200 的 `step`。
- 工具参数**不校验未知键**：把 `handle` 传给只认 `window` 的 `gui_locate` 不会报错，
  而是静默回退前台窗口、再报「没有前台窗口」。按 README 的工具表用参数名。

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
