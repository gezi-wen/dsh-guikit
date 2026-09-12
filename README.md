# sage-guikit · Sage GUI Toolkit

**Windows 桌面控制工具集**，给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 agent 装上眼睛和手：看屏幕、点鼠标、打字、按快捷键、滚动、等生效、管窗口，并能对标准控件做 Windows UI Automation 结构化定位。

Windows desktop-control toolset for DeepSeek Harness (DSH): monitor layout, annotated screenshots, click / type / key / scroll, pixel & window polling, window management, and UI Automation structured queries. Nine model tools, zero external dependencies — no resident service, no Python, no API key.

- 平台：**Windows 10/11**（不跨平台）
- 依赖：PowerShell 7（`pwsh`）+ .NET 的 `System.Drawing` / `UIAutomationClient`，都是系统自带
- 形态：DSH profile bundle（host 侧注册 9 个模型工具）

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

## 工具（9）

| 工具 | 参数 | 用途 |
|------|------|------|
| `gui_screen` | — | 显示器布局：每块屏的物理像素 bounds、虚拟桌面矩形、当前光标位置。多屏时副屏坐标可能为负。**任何坐标操作之前先调它** |
| `gui_screenshot` | `screen` / `x,y,w,h` / `annotate` / `step` | 截屏存 PNG 并返回路径（用 `read_image` 看）。`annotate=true` 把坐标网格标签画进图里（隔行隔列）+ 红色十字准星标光标位置——读标签报坐标，免去 DPI 换算 |
| `gui_click` | `x` `y` (必填) / `button` / `clicks` | 移动真实光标到物理像素坐标并点击。1=单击 2=双击 3=三击。点击后**回显焦点窗口**，点错立刻可见 |
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
| 视觉层 | `gui_screenshot annotate=true` | 自绘界面、游戏、CEF/Electron 这类 UIA 盲区：网格标签画进图里，agent 读标签报坐标 |
| 验证层 | `gui_wait` | 像素变化 / 窗口出现轮询，确认动作生效再继续 |

## 实现

每次工具调用 = 一个 PowerShell 子进程，注入内联 C#：

- `U32.v2.dll` 编译缓存（原子写入 tmp + Move、>4KB 完整性校验、失败自动回退内存编译），冷启动一次编译，之后只是 `Add-Type -Path`
- user32 `SendInput` / `SetCursorPos` / `EnumWindows` / `SetForegroundWindow`；UIA 走 `UIAutomationClient`
- `SetProcessDPIAware`：所有坐标一律物理像素，高 DPI 与多屏负坐标都安全
- 结果以 JSON 从 stdout 回传，转成 text block。stdout 在 PRELUDE 第一句显式钉死为 UTF-8——子进程没有控制台时 .NET 会回退到系统 ANSI 代码页（中文 Windows = gb2312），不钉死则回传的中文界面文本（UIA 元素名、窗口标题）会乱码

截图与编译缓存的落盘目录默认是 `%TEMP%\sage-guikit`，可用环境变量 `SAGE_GUIKIT_DIR` 覆盖。

## 已知边界

- **UIPI**：点不进管理员权限窗口；锁屏 / UAC 安全桌面完全不可达
- **Windows 前台锁**：程序化抢焦点会被系统静默拒绝——注入前先 `gui_window activate` 或点击目标窗口
- **z 序陷阱**：前台窗口切换后原坐标可能落到别的窗口上——靠 click/type 的焦点窗口回显发现
- **DPI-unaware 前台**：前台若是 DPI-unaware 的应用（常见于 CEF / 内嵌浏览器壳），Windows 的 DPI 虚拟化会缩放 `SetCursorPos` 坐标甚至返回 false。先激活一个 DPI-aware 窗口再点；Obsidian（Electron）正常
- **锁屏**：锁屏时 `SetCursorPos` 静默返回 false、光标冻住、前台 Idle。这是环境阻挡不是插件 bug——唯一判据是光标真能移动
- **UIA 盲区**：Electron/CEF 类应用在没装屏幕阅读器时基本只暴露空 Pane，这类必须走视觉标注坐标
- `gui_type` 的 clipboard 模式会覆盖用户剪贴板；unicode 模式更干净
- 工具操作的是**真实鼠标键盘**——跑自动化期间这块屏幕就是它的实验台，同机其它 agent 的输入会互相污染

## 定位

同类方案（如基于 MCP 的 Windows computer-use server）通常走无障碍树 + 视觉模型 + 常驻进程，能力更全，代价是额外运行时（Python/uvx）、常驻内存和 API key。本插件的取舍相反：**零依赖、无常驻、坐标直控，会话级即插即忘**，代价是没有视觉理解，坐标要靠 `gui_screen` / 标注截图自己算。

## License

MIT
