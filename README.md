# sage-guikit · Sage GUI Toolkit

**Windows 桌面控制工具集**，给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 agent 装上眼睛和手：看屏幕、单窗口截图、点鼠标、拖动、打字、按快捷键、滚动、等生效、管窗口，并能对标准控件做 Windows UI Automation 结构化定位。

Windows desktop-control toolset for DeepSeek Harness (DSH): monitor layout, whole-screen and single-window capture, click / drag / type / key / scroll, pixel & window polling, window management, and UI Automation structured queries. Eleven model tools, zero external dependencies — no resident service, no Python, no API key.

- 平台：**Windows 10/11**（不跨平台）
- 依赖：PowerShell 7（`pwsh`）+ .NET 的 `System.Drawing` / `UIAutomationClient`，都是系统自带
- 形态：DSH profile bundle（host 侧注册 11 个模型工具）

## 安装

```sh
# 1. 进 DSH profile 目录（例如 ~/.dsh/profiles/web）
cd <DSH profile 目录>
pnpm add sage-guikit

# 2. 在该目录的 package.json 里把 bundle 挂上
#    "dsh": { "profile": { "bundles": [ ..., "sage-guikit" ] } }

# 3. 重启 dsh web
```

本地开发用 `link:` 也行：

```json
"dependencies": { "sage-guikit": "link:E:/DSH-plugins/sage-guikit" }
```
⚠️ link 方式下裸导入从**源位置**向上解析，够不到 profile 的 `node_modules`——需要在插件目录自己跑一次 `pnpm install` 装 peer 依赖（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`）。从 npm 安装没有这个问题。

## 工具（11）

| 工具 | 参数 | 用途 |
|------|------|------|
| `gui_screen` | — | 显示器布局：每块屏的物理像素 bounds、虚拟桌面矩形、当前光标位置。多屏时副屏坐标可能为负。**任何坐标操作之前先调它** |
| `gui_screenshot` | `screen` / `x,y,w,h` / `annotate` / `step` | 截屏存 PNG 并返回路径（用 `read_image` 看）。`annotate=true` 把坐标网格标签画进图里（隔行隔列）+ 红色十字准星标光标位置——读标签报坐标，免去 DPI 换算 |
| `gui_window_shot` | `window` / `handle` / `annotate` / `step` | **单窗口截图**：用 PrintWindow 抓某个窗口自己的内容，**被别的窗口盖住也照样抓**，且不激活、不移动任何东西。返回 `x/y` 原点与 `scale`，换算 `屏幕坐标 = 原点 + 图坐标 × scale`。比整屏截图省一个数量级（实测 DSH 窗口 298 KB vs 整屏 8.8 MB） |
| `gui_click` | `x` `y` (必填) / `button` / `clicks` | 移动真实光标到物理像素坐标并点击。1=单击 2=双击 3=三击。点击后**回显焦点窗口**，点错立刻可见 |
| `gui_drag` | `fromX` `fromY` `toX` `toY` (必填) / `button` / `steps` / `stepDelayMs` | **按住拖动**：选文字、拖窗口标题栏、拉滑块/滚动条、拖放。移动是**插值**的（只调 SetCursorPos 不产生拖拽事件，多数程序不认）。`steps` 调大更稳更慢。无论成败都保证松开按键。回显焦点窗口 |
| `gui_type` | `text` (必填) / `mode` / `x` `y` | 向当前焦点控件打字。`unicode`（默认）逐字符 SendInput，绕过 IME，中文无损；`clipboard` 走剪贴板 Ctrl+V（会覆盖用户剪贴板）。可选先点击 (x,y) 定位焦点 |
| `gui_key` | `keys` (必填) | 真实键盘按键或组合键：`enter`、`ctrl+s`、`alt+f4`、`ctrl+shift+tab`、`win`、`printscreen`。修饰键 ctrl/alt/shift/win，f1–f24，a–z，0–9，方向键等 |
| `gui_scroll` | `x` `y` (必填) / `direction` / `notches` | 在 (x,y) 处滚轮。up/down 纵滚，left/right 横滚，默认 3 格 |
| `gui_window` | `action` (必填)：`list`/`rect`/`activate`/`move` | 窗口管理：列出可见窗口（标题/句柄/pid/进程/矩形/z 序）、取单个窗口 bounds、激活到前台、移动改尺寸 |
| `gui_wait` | `mode` (必填)：`pixel`/`window` | 轮询验证。`pixel` 盯某个像素：`compare=change` 与调用时基线比变化，`eq`/`neq` 比指定 RGB；`window` 等某个标题的顶层窗口出现。**点完先等生效再截图** |
| `gui_uia` | `action` (必填)：`tree`/`find`/`invoke`/`value` + `handle`/`title`/`name`/`elType`/`depth`/`max` | Windows UI Automation 结构化查询，一次限定一个窗口。`tree` 列可交互元素（名称/类型/矩形/可用）；`find` 按 Name 子串或控件类型定位；`invoke` 经 InvokePattern（回退 TogglePattern）**直按按钮，不用坐标**；`value` 经 ValuePattern **直读控件文本，验证输入无需截图**。返回的矩形是物理像素，可直接喂给 `gui_click` |

## 精度栈：三层互补

| 层 | 工具 | 适用 |
|----|------|------|
| 结构层 | `gui_uia` | 标准控件（Win32 / WPF / WinForms）：按名称或控件类型定位，直读直按，最省 token 也最可靠 |
| 视觉层 | `gui_window_shot` / `gui_screenshot annotate=true` | 自绘界面、游戏、CEF/Electron 这类 UIA 盲区：网格标签画进图里，agent 读标签报坐标。单看一个窗口用 `gui_window_shot`（被遮挡也抓得到，还省 token） |
| 验证层 | `gui_wait` | 像素变化 / 窗口出现轮询，确认动作生效再继续 |

日常顺序：`gui_screen` 拿布局 → `gui_window_shot` 看目标 → 标注坐标 → `gui_click` / `gui_drag` → `gui_wait` 验证 → 必要时 `gui_uia` 直读控件文本核对。

## 实现

每次工具调用 = 一个 PowerShell 子进程，注入内联 C#：

- `U32.<内容哈希>.dll` 编译缓存（原子写入 tmp + Move、>4KB 完整性校验、失败自动回退内存编译），冷启动一次编译，之后只是 `Add-Type -Path`。**文件名取自 C# 源码的内容哈希**，源码一改缓存自动失效——固定版本号那种写法会加载到缺新方法的旧 DLL，报「U32 不包含名为 X 的方法」
- user32 `SendInput` / `SetCursorPos` / `EnumWindows` / `SetForegroundWindow` / `PrintWindow`；UIA 走 `UIAutomationClient`。拖拽用 `SendInput` 绝对坐标 + `MOUSEEVENTF_VIRTUALDESK` 插值移动
- `SetProcessDPIAware`：所有坐标一律物理像素，高 DPI 与多屏负坐标都安全
- 结果以 JSON 从 stdout 回传，转成 text block。stdout 在 PRELUDE 第一句显式钉死为 UTF-8——子进程没有控制台时 .NET 会回退到系统 ANSI 代码页（中文 Windows = gb2312），不钉死则回传的中文界面文本（UIA 元素名、窗口标题）会乱码

截图与编译缓存的落盘目录默认是 `%TEMP%\sage-guikit`，可用环境变量 `SAGE_GUIKIT_DIR` 覆盖。

### 一个非显然的约束：别把脚本写胖

Windows Defender 会经 AMSI 扫描传给 `pwsh -Command` 的脚本。把「按标题找窗口 + GetWindowRect + PrintWindow + 画网格」全塞进一个脚本时，会被判为恶意脚本**直接拒绝执行**（报「此脚本包含恶意内容，已被防病毒软件阻止」）——枚举窗口标题 + 捕获窗口正是窥屏软件的特征。实测把窗口截图拆成独立工具、脚本压瘦后就不再触发。加功能时请留意脚本体积与 API 组合，改动后跑一遍 `smoke.mjs`。

## 已知边界

- **UIPI**：点不进管理员权限窗口；锁屏 / UAC 安全桌面完全不可达
- **Windows 前台锁**：程序化抢焦点会被系统静默拒绝——注入前先 `gui_window activate` 或点击目标窗口
- **z 序陷阱**：前台窗口切换后原坐标可能落到别的窗口上——靠 click/type 的焦点窗口回显发现
- **DPI-unaware 目标（点/拖/截都会受影响）**：DPI-unaware 的应用（WinForms 默认、部分 CEF 壳）在系统缩放 ≠ 100% 时受 Windows DPI 虚拟化影响：`SetCursorPos` 坐标被缩放甚至返回 false；拖拽的横向位移可能被吃掉（实测 175% 缩放下拖一个 unaware 窗口，纵向走 90px、横向 0px）；`gui_window_shot` 抓出来的图内容只铺在左上角一小块。**判据：`gui_window_shot` 返回的 `scale` > 1**（= 系统 DPI ÷ 窗口 DPI），此时按 `原点 + 图坐标 × scale` 换算，或先激活一个 DPI-aware 窗口再操作。Obsidian / Electron / Edge 这类 DPI-aware 应用全部正常
- **最小化窗口**：`gui_window_shot` 对最小化窗口会出黑图，先 `gui_window activate`
- **锁屏**：锁屏时 `SetCursorPos` 静默返回 false、光标冻住、前台 Idle。这是环境阻挡不是插件 bug——唯一判据是光标真能移动
- **UIA 盲区**：Electron/CEF 类应用在没装屏幕阅读器时基本只暴露空 Pane，这类必须走视觉标注坐标
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

同类方案（如基于 MCP 的 Windows computer-use server）通常走无障碍树 + 视觉模型 + 常驻进程，能力更全，代价是额外运行时（Python/uvx）、常驻内存和 API key。本插件的取舍相反：**零依赖、无常驻、坐标直控，会话级即插即忘**，代价是没有视觉理解，坐标要靠 `gui_screen` / 标注截图自己算。

## License

Apache-2.0 — 见 [LICENSE](LICENSE)，署名与第三方声明见 [NOTICE](NOTICE)。

Copyright 2026 Bowen Zheng (gezi-wen)

选 Apache-2.0 而不是 MIT，是因为它多两样东西：**明确的专利授权**（第 3 条），以及**`NOTICE` 必须随下游分发保留**（第 4(d) 条）——后者是 MIT 没有的，换协议之后别人 fork 走也没法把署名合法地删掉。
