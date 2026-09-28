# dsh-guikit · DSH GUI Toolkit

**Windows 桌面控制工具集**，给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 agent 装上眼睛和手：看屏幕、单窗口截图、点鼠标、拖动、打字、按快捷键、滚动、等生效、**验证生效**、管窗口，并能对标准控件做 Windows UI Automation 结构化定位，**以及按元素名直接定位到可点击坐标**（`gui_locate`）。

Windows desktop-control toolset for DeepSeek Harness (DSH): monitor layout, whole-screen and single-window capture, click / drag / type / key / scroll, pixel / window / semantic verification, window management, UI Automation structured queries, and element-name lookup. Thirteen model tools, zero external dependencies — no resident service, no Python, no API key.

- 平台：**Windows 10/11**（不跨平台）
- 依赖：PowerShell 7（`pwsh`）+ .NET 的 `System.Drawing` / `UIAutomationClient`，都是系统自带
- 形态：DSH profile bundle（host 侧注册 13 个模型工具）

## 安装

```sh
# 1. 进 DSH profile 目录（例如 ~/.dsh/profiles/web）
cd <DSH profile 目录>
pnpm add dsh-guikit

# 2. 在该目录的 package.json 里把 bundle 挂上
#    "dsh": { "profile": { "bundles": [ ..., "dsh-guikit" ] } }

# 3. 重启 dsh web
```

本地开发用 `link:` 也行：

```json
"dependencies": { "dsh-guikit": "link:<你 clone 下来的目录>" }
```
⚠️ link 方式下裸导入从**源位置**向上解析，够不到 profile 的 `node_modules`——需要在插件目录自己跑一次 `pnpm install` 装 peer 依赖（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`）。从 npm 安装没有这个问题。

## 工具（13）

| 工具 | 参数 | 用途 |
|------|------|------|
| `gui_screen` | — | 显示器布局 + **坐标契约**：每块屏的 `physical_rect{x,y,w,h}` / `logical_rect` / `dpi_scale` / `is_primary` / `display_id`，顶层 `virtual_desktop_origin{x,y}` 与 `space:"virtual-desktop-physical"`。`dpi_scale` 按屏取（`MonitorFromPoint` + `GetDpiForMonitor`），**取不到时是 `null`——不假装 1.0**（`logical_rect` 同时为 `null`）。旧的 `x/y/w/h/primary/device` 与 `virtual`/`cursor` 全部保留。**任何坐标操作之前先调它** |
| `gui_screenshot` | `screen` / `x,y,w,h` / `annotate` / `step` | 截屏存 PNG 并返回路径（用 `read_image` 看）。回执带 `space:"virtual-desktop-physical"` / `origin{x,y}` / `image_px{w,h}` / `scale` / `note`。`annotate=true` 画**顶部+左侧标尺**、**对齐网格交点的坐标标签**和**左下角水印**（水印内容即 `origin`/`space`/`scale`/`region`/`step`）——**别按图上像素距离量坐标，读标签文本** |
| `gui_window_shot` | `window` / `handle` / `annotate` / `step` | **单窗口截图**：PrintWindow 抓窗口自己的内容，**被别的窗口盖住也照样抓**，不激活、不移动。回执带 `space:"window-local"` / `origin{x,y}`（= 旧的 `x/y`，两个名字都在）/ `scale` / `image_px`；annotate 同样画标尺与左下角水印，标尺标签用**绝对屏幕坐标**。比整屏省一个数量级（实测 DSH 窗口 298 KB vs 整屏 8.8 MB） |
| `gui_locate` | `name`(必填) / `window`（`title` 是等价别名） / `elType` / `index` / `depth` / `max` / `timeoutMs` | **元素名 → 可点击坐标**。在目标窗口（`window` 标题子串或 handle，不给就用前台窗口兜底）按 `name`（可选 `elType` / `index`）用 UIA 定位，返回**可直接喂 `gui_click` 的虚拟桌面物理像素** `point{x,y}`（元素矩形中心）+ `rect` + `type` + `enabled` + `offscreen` + `uiaPath`（祖先链数组，最多 6 层）+ `total`/`matched`/`depth_reached` + `space`/`origin`/`scale`。**七个状态里只有 `status="found"` 会给顶层 `point`**（绝不返回猜测坐标）：`ambiguous` 回 `candidates[]` 前 5 个候选（各带 rect/point/offscreen；离屏候选的 `point` 为 `null`），`offscreen` / `not-found` / `not-exposed` / `inconclusive` / `truncated` 一律不给 point。`timeoutMs` 给了就**反复重走直到元素出现**（250 ms 间隔；默认 0 = 单次）；`index` 越界 → 明确 error 并附 `validIndex`（不静默回落 0）。见「UIA 五态」一节 |
| `gui_click` | `x` `y` (必填) / `button` / `clicks` / **`window`** / **`space`** / **`verify`** | 真实光标移到物理像素并点击。1/2/3 = 单/双/三击。**`window`** 是 per-call 目标（标题子串或 handle，不再只认当前前台）；**`space="window-local"`** 时（必须给 `window`）入参按 `gui_window_shot` 的图内像素解释，换算在 pwsh 里做。回执新增 `space` / `origin` / `scale` / `requested` / `absolute` / `insideWindow` / `target`（旧 `x`/`y`/`result`/`fgTitle`/`fgHandle` 保留）。**`verify` 可选**：点完在同一进程内立刻跑一次 `gui_verify` 等价断言，结果并进 `verify:{verdict,detail,observed,tries,streak}`，默认关；**`delivery.verified` 只在 verdict=`satisfied` 时为 true** |
| `gui_drag` | `fromX` `fromY` `toX` `toY` (必填) / `button` / `steps` / `stepDelayMs` / **`window`** / **`space`** | **按住拖动**：选文字、拖标题栏、拉滑块/滚动条、拖放。移动是**插值**的（只 SetCursorPos 不产生拖拽事件）。`steps` 调大更稳更慢。无论成败都保证松开按键。`window`/`space` 语义与 `gui_click` 一致（四个坐标一起换算），回执同样回带 `space`/`origin`/`scale`/`insideWindow`，**`requested`/`absolute` 是 `{from,to}` 两点**，`insideWindow` 要求**起点与终点都在窗口内** |
| `gui_type` | `text` (必填) / `mode` / `x` `y` | 向当前焦点控件打字。`unicode`（默认）逐字符 SendInput，绕过 IME，中文无损；`clipboard` 走剪贴板 Ctrl+V（会覆盖用户剪贴板）。可选先点击 (x,y) 定位焦点 |
| `gui_key` | `keys` (必填) | 真实键盘按键或组合键：`enter`、`ctrl+s`、`alt+f4`、`ctrl+shift+tab`、`win`、`printscreen`。修饰键 ctrl/alt/shift/win，f1–f24，a–z，0–9，方向键等 |
| `gui_scroll` | `x` `y` (必填) / `direction` / `notches` | 在 (x,y) 处滚轮。up/down 纵滚，left/right 横滚，默认 3 格 |
| `gui_window` | `action` (必填)：`list`/`rect`/`activate`/`move` | 窗口管理：列出可见窗口（标题/句柄/pid/进程/矩形/z 序）、取单个窗口 bounds、激活到前台、移动改尺寸 |
| `gui_wait` | `mode` (必填)：`pixel`/`window` | 轮询验证。`pixel` 盯某个像素：`compare=change` 与调用时基线比变化，`eq`/`neq` 比指定 RGB；`window` 等某个标题的顶层窗口出现。**点完先等生效再截图** |
| `gui_verify` | `mode` (必填)：`element`/`window` + `title`/`handle`/`name`/`elType`/`enabled`/`valueEquals`/`boundsX..H`/`tolerancePx`/`timeoutMs`/`stableSamples` | **语义验证**：断言一个 UIA 元素存在（可选再要求可用 / 值相等），或断言某窗口存在（可选再比对 bounds）。连续 `stableSamples` 次都成立才算数，否则轮询到超时。返回三态 **`satisfied` / `unsatisfied` / `unknown`**——`unknown` 是「判不出来」，**绝不可当成功读**。缺席不可证明，所以 `exists:false` 会被拒。**0.6.0 起与 `gui_uia` 遍历器同源**（RawView + depth 40），Chromium a11y 也够得到——同一断言前后对照：`unknown`(5201 ms/tries=6) → `satisfied`(140 ms/tries=1)。**输入类工具之后跟一次它，才算拿到结论** |
| `gui_uia` | `action` (必填)：`tree`/`find`/`invoke`/`value` + `handle`/`title`/`name`/`elType` / `depth` (默认 **40**，硬顶 40) / `max` (默认 **2000**，硬顶 **8000**；遍历预算) / **`maxRows`** (默认 **120**，硬顶 2000；返回预算) | Windows UI Automation 结构化查询，一次限定一个窗口。**0.6.0 改走 `RawViewWalker` 并把 `depth` 提到 40**（两个机制叠加，见「UIA 五态」一节）。回带 `total`/`matched`/`truncated`/`rows_truncated`/`depth_reached`/`walker`。**返回五态 `status`**（见「UIA 五态」一节；只有 `empty-but-accessible` 能读成「确实没有」）。`invoke` 经 InvokePattern（回退 TogglePattern）**直按按钮，不用坐标**；`value` 经 ValuePattern **直读控件文本**。返回的 `type` 是**短名**（`Button`，不再是 `ControlType.Button`）；矩形是物理像素，可直接喂 `gui_click` |

## 坐标系契约

三套空间同时存在，工具之间**不互相猜**：每一步都把空间名与换算所需的数回带出来。

```
                 虚拟桌面（本机 5360×1750，origin (0,-278)）
   ┌─────────────────────────────────────────────────────────────┐ y=-278
   │  副屏 DISPLAY1 2800×1750 @200%        ┌──────────────────┐   │
   │                                       │ 主屏 2560×1440   │   │
   │  (1) 虚拟桌面物理像素                 │      @154%       │   │
   │      = 所有坐标类工具的输入口径       └──────────────────┘   │
   │      gui_screen.virtual_desktop_origin                       │
   └─────────────────────────────────────────────────────────────┘ y=1472
     x=0                                                       x=5360

   gui_screenshot x=0,y=-278,w=1600,h=1000
   ┌──────────────── 图像像素（图左上 = 截取区域左上）──────────────┐
   │ ┊ ┊ ┊ ┊ ┊ ┊ ┊ ┊   ← 顶部标尺：每条网格列上 y=0..13 的不透明刻线  │
   │ ────────────────  ← 左侧标尺：每条网格行上 x=0..13              │
   │ 0,-278      240,-278      480,-278   ← 标签 = 绝对桌面坐标      │
   │                                                              │
   │ origin=(0,-278) space=virtual-desktop scale=1 ...            │  ← 左下角水印
   └──────────────────────────────────────────────────────────────┘
     read_image 再降采样 ×1.50（本机 5360→3584）：文字还在，尺寸变小
```

| 空间 | 谁在用 | 原点 |
|------|--------|------|
| **虚拟桌面物理像素** `virtual-desktop-physical` | `gui_click` / `gui_drag` / `gui_wait` 的**入参**；`gui_screen` / `gui_uia` / `gui_verify` / `gui_locate` 的**回带** | 虚拟桌面左上（本机 `(0,-278)`，副屏可为负） |
| **截图图像像素**（`gui_screenshot`） | `read_image` 看到的那张全屏/区域图 | 图左上 = 截取区域左上 |
| **窗口局部像素** `window-local`（`gui_window_shot`） | 单窗口截图；`gui_click`/`gui_drag` 的 `space="window-local"` 入参 | 窗口左上 |

**换算只有两个方向，都是单程：**

- 图内像素 → 桌面坐标：`绝对 = origin + 图内像素 × scale`
- 桌面坐标 → 图内像素：`图内 = (绝对 − origin) ÷ scale`

`scale` 由工具回带，不要自己估：`gui_screenshot` 恒为 `1`（图与桌面 1:1）；`gui_window_shot` 与
`space="window-local"` 在 **DPI-unaware 窗口上可能 > 1**（= 系统 DPI ÷ 窗口 DPI）。

**`read_image` 还会再缩放一次**（本机整屏 5360 → 3584，×1.50）——这一层**图素间距不可信**，
所以坐标一律**读图内烧好的标签文本**（标签是绝对桌面坐标），或改用下面这条零换算路径。

**为什么要加标尺与水印**：0.5.x 的 annotate 标签与真实网格线**有递增偏差**
（实测 240→195px、480→355px、720→515px，随坐标增大），照标签估坐标会系统性点偏；
而 `read_image` 那层降采样又让图素间距无法反推。所以 0.6.0 把「换算依据」直接烧进图里：
**顶部/左侧标尺**给出网格的真实图内位置、**标签**逐字对应它标记的交点、**左下角水印**带上
`origin`/`space`/`scale`/`region`/`step`——这三样都可以用像素探针断言，不再依赖「看起来对齐」。

**零换算路径（推荐）**：`gui_window_shot` 出图 → `gui_click space="window-local" window="<同一窗口>"`
直接喂图内像素，换算在 pwsh 里做，回执里的 `absolute` 才是真正投递的桌面坐标。
水印把换算依据跟图绑在一起——图存下来再回看时也不丢。

## UIA 五态：`gui_uia` / `gui_locate` 的 `status`

`gui_uia`（`tree`/`find`）与 `gui_locate` 都回带 `status`。**「查不到」不等于「不存在」**，
五态把这两件事分开，模型才知道下一步该换路、该加预算，还是该收工：

> **只有 `empty-but-accessible` 允许读成「确实没有」。**
> `not-exposed` / `inconclusive` / `truncated` 都**不是**「元素不存在」的证明：
> 第一个要换视觉路径，第二个要人工判断（空窗口与 a11y 被藏分不清），第三个要放宽预算重查。

下面是 `gui_uia` 的五态：

| `status` | 含义 | 判定（都是「遍历自然走完」的前提下） | 模型该怎么反应 |
|----------|------|--------------------------------------|----------------|
| `found` | 命中（`gui_uia` 的 `invoke`/`value` 也在此态才有元素可用） | 有匹配 | 直接用 `rect` / `point`，或 `invoke` / `value` |
| `empty-but-accessible` | 树里有内容（有 Text 或可交互控件），但**确实没匹配** | 自然走完 + 树有内容 + 无匹配 | 换个 `name` / `elType` 再试，或换窗口 |
| `not-exposed` | **有节点但零内容节点**——自绘界面，或该应用没点亮 Chromium a11y | 自然走完 + `textNodes == 0` 且可交互控件数 == 0 + **`total > 0`** | **立刻换视觉路径**：`gui_screenshot annotate=true` 读标签，或用 `gui_locate`/`gui_click`。回执里带这条 hint |
| `inconclusive` | **一个节点都没有**——空白窗口与「a11y 被藏」（Qt / 自绘）分不清 | 自然走完 + **`total == 0`** | 别重试（不会变）；hint 两种可能都提。若你确信这里有内容，走视觉路径 |
| `truncated` | 遍历**被 depth / max 截断**且无匹配——有没有答案**不知道** | 撞了 `depth` 或 `max` 上限 | 提高 `depth` / `max`（`max` 可到 8000），或先用更宽的 `name` 试；**absence 未证明** |

**`gui_locate` 的 `status` 是更大的集合**（它多了「命中几个 / 能不能点」这两维）：
`found`（唯一命中，或给了 `index`，且中心在窗口内）/ `ambiguous`（命中 >1 又没给 `index`——
回 `candidates[]` 前 5 个候选，各带 rect/point/offscreen，顶层**不给** `point`，不替你猜）/
**`offscreen`**（元素存在但离屏，或中心落在窗口 rect 外——先滚动/切标签/激活窗口让它可见，**别点那个坐标**）/
`not-found`（＝`gui_uia` 的 `empty-but-accessible`：遍历走完、确实没匹配）/ `not-exposed` / `inconclusive` / `truncated`。

**「绝不猜测坐标」的可读表达**：这 7 个状态里**只有 `found` 会给顶层 `point`**；
`ambiguous` 只给候选列表（离屏候选的 `point` 是 `null`），其余五态一个都不给。
`offscreen` 不是理论顾虑——本机 DSH 窗口实测 `elType=Text` 里有 **1202/1297** 个元素 `offscreen:true`、
**1130** 个 y < −1000（最深的 y = **−15585**）：直接把这些坐标喂给 `gui_click`，就会点到窗口外的别处。
`gui_locate` 的目标窗口用 `window`（标题子串或 handle，**推荐**）或它的别名 `title`
（两者都给时 `window` 优先）；都不给就用前台窗口兜底。两者共用「自然走完」这条底线与 `total` 分流规则。

四条容易踩的细节：

- **`depth` 默认 40 是必需的，不是保守值**。两种机制叠加（同一 DSH 窗口实测，可用 `probe-control-vs-raw.ps1` 复跑）：
  1. **`ControlViewWalker` 与 `FindAll(Descendants)` 只返回 `IsControlElement=true` 的元素**——
     本机同一窗口两者都给 **818**，而 `RawViewWalker` 给 **1578**，所以它们会漏掉非控件节点：
     实测有 **17** 个非控件元素落在 depth ≤ 14 内、会被直接跳过。
  2. **更主要的是 `depth` 预算在两种遍历器之间不等价**：RawView 的中间层把真实内容推深
     （**743** 个非控件元素在 depth > 14），而 ControlView 是塌缩视图，depth 14 就覆盖了全部 818 个控件元素。

  ⇒ **只换 walker 不提 depth 会比 0.5.x 更差**（同一窗口 ControlView@10 = 46 个元素 vs RawView@10 = **14** 个）；
  `depth` 默认 40 是**必需**。默认给 10 会把有 a11y 的窗口**误判成空壳**，所以 `not-exposed` 还额外要求「遍历自然走完」。
- **`total` 才是「遍历覆盖量」**（本窗口 1578），`matched` 是「匹配数」、`count` 是「回带行数」——
  **三者不要混用**；五态分流看 `total`。**`FindAll(Descendants)` 不是全量**（818 vs 1578）：
  任何「用 `FindAll` 数元素」的直觉都不成立，这也解释了旧实现为什么会漏元素。
- **`max` 与 `maxRows` 是两件事**：`max` 是**遍历预算**（默认 2000、硬顶 8000），`maxRows` 是**返回预算**
  （默认 120、硬顶 2000）。被返回预算截断时 `rows_truncated=true` 且附 hint——**默认 120 行不是全部**，
  要全量就显式提高 `maxRows`（本机 DSH 窗口 `total` 实测 1500+，默认全量返回等于上百 KB JSON 灌进上下文）。
  反过来，**`max` 停在 2000 会让「不存在」永远无法被证明**：本机主窗口真树有 2450~2522 个元素，
  默认预算下工具会诚实回 `truncated`，要下「确实没有」的结论就得显式 `max: 8000` 走完。
  （元素数随窗口内容漂移，同一窗口不同时刻实测过 1578 / 2450~2522 —— 别按固定值估。）
- **`hints` 是数组，`hint` 取第一条**：状态类 hint（`not-exposed` / `inconclusive` / `truncated`）排在
  `rows_truncated` 的 hint 之前，所以只读 `hint` 也能拿到「最该先看的那条」。
- **别跑一次就下结论**：窗口初始化未完成时，同一窗口的**元素数会瞬态翻倍**
  （实测同一个 3 按钮窗口先回 `total=6`、后回 `total=3`）。要么重跑一次确认，要么优先信 `gui_verify` 那种
  「连续 N 次都成立才算数」的断言。

`not-exposed` 时最多再重试 1 次（实测 4 分钟内读数一动不动），重试落在同一个 pwsh 进程里；
`invoke`/`value` 在 `not-exposed` / `inconclusive` / `truncated` 下**不会**报误导性的「no element matching」，
而是回同样的 `status` + hint。

## 精度栈：三层互补

| 层 | 工具 | 适用 |
|----|------|------|
| 结构层 | `gui_uia` / `gui_locate` | 标准控件（Win32 / WPF / WinForms / 已点亮 a11y 的 Chromium）：`gui_locate` 把元素名直接换成可点击坐标，`gui_uia` 按名称或控件类型直读直按，最省 token 也最可靠 |
| 视觉层 | `gui_window_shot` / `gui_screenshot annotate=true` | 自绘界面、游戏、**没有点亮 Chromium a11y 的应用**：标尺与标签画进图里，agent 读标签报坐标。单看一个窗口用 `gui_window_shot`（被遮挡也抓得到，还省 token） |
| 验证层 | `gui_verify` / `gui_wait` | `gui_verify` 走语义（元素存在/可用/值相等、窗口存在/bounds）并给出 `satisfied`/`unsatisfied`/`unknown` 三态结论；`gui_wait` 走像素变化与窗口出现，更便宜但只说明「有变化」 |

日常顺序：`gui_screen` 拿布局 → `gui_locate` 试语义定位（命中即得坐标，零换算）→
没命中再 `gui_window_shot` 出图、`annotate` 读标签 → `gui_click`（窗口内可直接 `space="window-local"`）
→ **`gui_verify` 拿结论**（或 `gui_wait` 等变化）→ 必要时 `gui_uia` 直读控件文本核对。

### 输入类工具的回执：`sent` 不等于生效

`gui_click` / `gui_drag` / `gui_type` / `gui_key` / `gui_scroll` 的返回值都带：

```json
"delivery": { "sent": true, "verified": false, "note": "..." }
```

它只说明**事件送进了 OS**，不说明**目标有反应**——实测过点击回执 `ok` 而界面纹丝不动（Chromium 丢弃后台 `PostMessage`、合成光标被实时抢走）。要结论就得跟一次 `gui_verify`；只读类工具（`gui_screen` / `gui_uia` / `gui_verify`）不挂这个字段。`gui_click` 另外回显 `requested:{x,y}`，与落到实处的 `x,y` 并排，两者对不上时一眼可见。

`gui_click` 另有一个可选参数 `verify`：参数与 `gui_verify` 同名（`mode` 必填，另有 `title`/`handle`/
`name`/`elType`/`enabled`/`valueEquals`/`exists`/`boundsX..H`/`tolerancePx`/`timeoutMs`/`stableSamples`/
`intervalMs`；这个对象设了 `additionalProperties: false`，键名写错会被 schema 直接拒）。给了它，
点击之后会在**同一个 pwsh 进程内**跑一次与 `gui_verify` 等价的断言，结果并进回执
`verify:{verdict,detail,observed,tries,streak}`。此时 `delivery.sent` 仍是 `true`（事件确实送进了 OS），
而 **`delivery.verified` 只有在 verify 判定 `satisfied` 时才为 `true`**——`unsatisfied` / `unknown`
都保持 `false`；`delivery.note` 会写明这是「工具内断言」的判定结果，并点明**只有 `satisfied` 才算
verified**（不给 `verify` 时仍是原来那句「SENT, not confirmed」）。默认关；关键操作建议开，
省掉「再跟一次 gui_verify」这一步。

## 实现

每次工具调用 = 一个 PowerShell 子进程，注入内联 C#：

- `U32.<内容哈希>.dll` 编译缓存（原子写入 tmp + Move、>4KB 完整性校验、失败自动回退内存编译），冷启动一次编译，之后只是 `Add-Type -Path`。**文件名取自 C# 源码的内容哈希**，源码一改缓存自动失效——固定版本号那种写法会加载到缺新方法的旧 DLL，报「U32 不包含名为 X 的方法」
- user32 `SendInput` / `SetCursorPos` / `EnumWindows` / `SetForegroundWindow` / `PrintWindow`；UIA 走 `UIAutomationClient`。拖拽用 `SendInput` 绝对坐标 + `MOUSEEVENTF_VIRTUALDESK` 插值移动
- `SetProcessDPIAware`：所有坐标一律物理像素，高 DPI 与多屏负坐标都安全；逐屏 DPI 另走 `MonitorFromPoint` + `GetDpiForMonitor`（取不到就回 `null`，不假装 100%）
- 结果以 JSON 从 stdout 回传，转成 text block。stdout 在 PRELUDE 第一句显式钉死为 UTF-8——子进程没有控制台时 .NET 会回退到系统 ANSI 代码页（中文 Windows = gb2312），不钉死则回传的中文界面文本（UIA 元素名、窗口标题）会乱码

截图与编译缓存的落盘目录默认是 `%TEMP%\dsh-guikit`，可用环境变量 `DSH_GUIKIT_DIR` 覆盖。

### 一个非显然的约束：别把脚本写胖

Windows Defender 会经 AMSI 扫描传给 `pwsh -Command` 的脚本。把「按标题找窗口 + GetWindowRect + PrintWindow + 画网格」全塞进一个脚本时，会被判为恶意脚本**直接拒绝执行**（报「此脚本包含恶意内容，已被防病毒软件阻止」）——枚举窗口标题 + 捕获窗口正是窥屏软件的特征。实测把窗口截图拆成独立工具、脚本压瘦后就不再触发。加功能时请留意脚本体积与 API 组合，改动后跑一遍 `smoke.mjs`。

## 已知边界

- **UIPI**：点不进管理员权限窗口；锁屏 / UAC 安全桌面完全不可达
- **Windows 前台锁**：程序化抢焦点会被系统静默拒绝——注入前先 `gui_window activate` 或点击目标窗口。动作类工具可带 `window` 显式指定目标，不必依赖「当前前台」
- **z 序陷阱**：前台窗口切换后原坐标可能落到别的窗口上——靠 click/type 的焦点窗口回显发现
- **DPI-unaware 目标（点/拖/截都会受影响）**：DPI-unaware 的应用（WinForms 默认、部分 CEF 壳）在系统缩放 ≠ 100% 时受 Windows DPI 虚拟化影响：`SetCursorPos` 坐标被缩放甚至返回 false；拖拽的横向位移可能被吃掉（实测 175% 缩放下拖一个 unaware 窗口，纵向走 90px、横向 0px）；`gui_window_shot` 抓出来的图内容只铺在左上角一小块。**判据：`gui_window_shot` 返回的 `scale` > 1**（= 系统 DPI ÷ 窗口 DPI），此时按 `原点 + 图坐标 × scale` 换算，或改用 `space="window-local"` 让工具自己换算。Obsidian / Electron / Edge 这类 DPI-aware 应用全部正常
- **最小化窗口**：`gui_window_shot` 对最小化窗口会出黑图，先 `gui_window activate`
- **锁屏**：锁屏时 `SetCursorPos` 静默返回 false、光标冻住、前台 Idle。这是环境阻挡不是插件 bug——唯一判据是光标真能移动
- **UIA 不暴露 ≠ Electron**：能不能走 UIA **取决于该应用有没有点亮 Chromium 的 a11y**，不是「Electron/CEF 一律是盲区」。DSH 自己的 Electron 窗口裸 UIA 就有 470 个元素（`RawViewWalker` 数百到近千个，随窗口内容漂移），而某些第三方 Electron 壳（实测 `OrpheusBrowserHost`：`total=4` / `textNodes=0` / 可交互控件=0）只暴露空壳。点亮手法**无客户端解法**（`WM_GETOBJECT`、事件订阅、`CacheRequest`、`SPI_SETSCREENREADER` 全部实测无效），所以这类应用只能走视觉路径——`gui_uia` / `gui_locate` 会明确回 `not-exposed` 并给 hint，**不会假装「控件不存在」**
- **拖拽起拖阈值**：Windows 从按下到认定「开始拖动」之间的位移不生效，所以 `gui_drag` 的**实际位移总比请求短约 8–11px**（实测：请求 +150/+30 → 实际 +142/+28；请求 −260/−28 → 实际 −249/−28；请求 +117 → 实际 +111）。**要精确落位用 `gui_window move`（SetWindowPos，无阈值）**，拖拽适合「移过去就够」的场景
- **Cloudflare Turnstile**：勾选框式人机验证对自动化会话不放行（点了也过不去）——反自动化闸门不硬碰，直接换可达站点
- **annotate 会静默粗化 `step`**：区域面积 > 500 万像素且 `step` < 200 时，实际步长被改成 240，而**回执里不自报实际值**（只有图内水印写了）。要让程序化链路知道步长，显式传一个 ≥ 200 的 `step`
- **未知参数会被静默忽略**：工具参数对象没有设 `additionalProperties: false`，把 `handle` 传给只认 `window` 的 `gui_locate` 不会报错，而是静默回退前台窗口、再报「没有前台窗口」。按上表用参数名：`gui_locate`/`gui_click`/`gui_drag` 用 `window`（`gui_locate` 另收 `title`），`gui_uia`/`gui_verify` 用 `title`
- `gui_type` 的 clipboard 模式会覆盖用户剪贴板；unicode 模式更干净
- 工具操作的是**真实鼠标键盘**——跑自动化期间这块屏幕就是它的实验台，同机其它 agent 的输入会互相污染

## 开发

```sh
pnpm install          # peer 由 DSH 闭包提供；这里装的是 devDependencies
node smoke.mjs        # 被动冒烟：布局 / 区域截图 / 窗口截图 / 窗口列表 / UIA / 等待
node smoke-drag.mjs   # 拖拽端到端：起一个 DPI-aware 测试窗口，拖它标题栏并核对位移
```

`smoke-drag.mjs` 会接管真实鼠标 1–2 秒，同屏有别的 agent 在跑 GUI 自动化时不要跑。

## 定位

同类方案（如基于 MCP 的 Windows computer-use server）通常走无障碍树 + 视觉模型 + 常驻进程，能力更全，代价是额外运行时（Python/uvx）、常驻内存和 API key。本插件的取舍相反：**零依赖、无常驻、坐标直控，会话级即插即忘**，代价是没有视觉理解——坐标靠 `gui_screen` 给契约、`gui_locate` 直接换出可点坐标、标注截图自证，**不需要模型心算换算**。

## License

Apache-2.0 — 见 [LICENSE](LICENSE)，署名与第三方声明见 [NOTICE](NOTICE)。

Copyright 2026 gezi-wen

选 Apache-2.0 而不是 MIT，是因为它多两样东西：**明确的专利授权**（第 3 条），以及**`NOTICE` 必须随下游分发保留**（第 4(d) 条）——后者是 MIT 没有的，换协议之后别人 fork 走也没法把署名合法地删掉。
