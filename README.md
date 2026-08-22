# sage-guikit · Sage GUI Toolkit

DeepSeek Harness (DSH) 插件——让 agent 能看屏幕、点鼠标、打字、按快捷键、管理窗口。Windows 原生，零外部依赖。

## 工具

| 工具 | 功能 |
|------|------|
| `gui_screen` | 显示器布局 / 虚拟桌面 / 光标位置（物理像素，多屏负坐标安全） |
| `gui_screenshot` | 全桌面 / 单屏 / 任意区域截图 → PNG（模型用 read_image 看图） |
| `gui_click` | 真实鼠标移动 + 点击（左/右/中键，单/双/三击） |
| `gui_type` | 打字：Unicode 直注（绕 IME，支持中文）或剪贴板粘贴 |
| `gui_key` | 组合键（ctrl+s / alt+f4 / win / printscreen ...） |
| `gui_window` | 窗口列表 / 激活 / 移动 / 查坐标 |

## 实现

每个工具调用 = PowerShell 子进程 + `Add-Type` 内联 C#（user32 `SendInput` / `SetCursorPos` / `EnumWindows`）+ JSON stdout 回传。
`SetProcessDPIAware` 保证高 DPI 下坐标即物理像素。无常驻服务、无 Python、无 API key。

## 安装（DSH profile）

```sh
# 1. package.json dependencies 加 "sage-guikit": "link:E:/workspace/sage-guikit"
# 2. package.json dsh.profile.bundles 加 "sage-guikit"
# 3. 插件目录装 peer 依赖（铁律，缺了 import 会失败）
cd E:\workspace\sage-guikit && pnpm install
# 4. profile 目录 pnpm install，重启 dsh web
```

## 已知边界

- UIPI：点不了管理员权限的窗口；锁屏 / UAC 安全桌面不可达
- 坐标点击是「盲点」，复杂控件的结构化定位可搭配 Windows-MCP（UIA）
- `gui_type` clipboard 模式会覆盖用户剪贴板；unicode 模式绕过 IME 更干净
- 注入前先点击目标或 `gui_window activate`——程序化抢前台会被 Windows 前台锁静默拒绝

## 调研背景（为什么自研）

- dsh-computer-use：桌面控制半边 macOS 专属，Win11 不可用
- Windows-MCP：社区最优但 issue #385（DSH 子进程下 UIA 空桌面）+ 遥测默认开 + 常驻 150-250MB
- 详见圣殿记忆 `project_guikit.md`
