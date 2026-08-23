# sage-guikit · Sage GUI Toolkit

DeepSeek Harness (DSH) 插件——让 agent 能看屏幕、点鼠标、打字、按快捷键、滚动、等待验证、管理窗口，并能对标准控件做 UIA 结构化定位与直读。Windows 原生，零外部依赖。

## 精度栈（三层互补）

| 层 | 工具 | 适用 |
|----|------|------|
| 结构层 | `gui_uia` | 标准控件：按 Name / 控件类型定位；`invoke` 经 InvokePattern 直按按钮（最可靠）；`value` 经 ValuePattern 直读控件文本（输入验证无需截图） |
| 视觉层 | `gui_screenshot annotate=true` | 自绘界面、游戏、UIA 盲区：坐标网格画进图里（隔行隔列标签），读标签报坐标，DPI 误差归零；红色十字准星标记光标 |
| 验证层 | `gui_wait` | 像素变化 / 窗口出现轮询——点击后确认生效再继续 |

操作层：`gui_click` / `gui_type` / `gui_key` / `gui_scroll` / `gui_window`。
click 与 type 回显点击后的焦点窗口——点错立刻可见。

## 全部工具（9）

`gui_screen` 显示器布局 · `gui_screenshot` 截图+标注 · `gui_click` 点击 · `gui_type` 打字（Unicode 绕 IME 中文无损 / 剪贴板粘贴）· `gui_key` 组合键 · `gui_scroll` 滚轮（纵/横）· `gui_wait` 等待验证 · `gui_window` 窗口管理 · `gui_uia` 结构化查询

## 实现

每个工具调用 = PowerShell 子进程 + `U32.v2.dll` 编译缓存（原子写入 tmp+Move、>4KB 完整性校验、失败自动回退内存编译）+ user32 `SendInput`/`SetCursorPos`/`EnumWindows`；UIA 走 `UIAutomationClient`。`SetProcessDPIAware` 保证高 DPI 下坐标即物理像素。无常驻服务、无 Python、无 API key。

## 安装（DSH profile）

```sh
# 1. profile 的 package.json dependencies 加 "sage-guikit": "link:E:/workspace/sage-guikit"
# 2. 同文件 dsh.profile.bundles 加 "sage-guikit"
# 3. 插件目录装 peer 依赖（铁律：link 包的裸导入从源位置解析，够不到 profile node_modules）
cd E:\workspace\sage-guikit && pnpm install
# 4. profile 目录 pnpm install，重启 dsh web
```

## 已知边界

- UIPI：点不了管理员权限窗口；锁屏 / UAC 安全桌面不可达
- Windows 前台锁：程序化抢焦点会被静默拒绝——注入前先 `gui_window activate` 或点击目标
- z 序陷阱：前台窗口切换后，原坐标可能落到别的窗口上——靠 click/type 的焦点回显发现
- `gui_type` clipboard 模式覆盖用户剪贴板；unicode 模式绕过 IME 更干净
- DPI-unaware 前台窗口：前台若是 DPI-unaware 的 App（常见于 CEF/内嵌浏览器类），Windows 的 DPI 虚拟化会把 `SetCursorPos` 坐标缩放甚至返回 false。先激活一个 DPI-aware 窗口再点击；Obsidian(Electron) 正常
- 锁屏：桌面锁屏时 `SetCursorPos` 静默返回 false、光标冻住、前台 Idle——这是环境阻挡，不是插件 bug；判据是光标真能移动
- Electron/CEF 类应用 UIA 基本只能拿到空 Pane（无屏幕阅读器时不暴露交互树），这类必须走视觉标注坐标

## 调研背景（为什么自研）

- dsh-computer-use：桌面控制半边 macOS 专属，Win11 不可用
- Windows-MCP：社区最优但 issue #385（DSH 子进程下 UIA 空桌面）——本插件实测 UIA 在 DSH 子进程正常；遥测默认开 + 常驻 150-250MB 是它的额外代价
- 详见圣殿记忆 `project_guikit.md`
