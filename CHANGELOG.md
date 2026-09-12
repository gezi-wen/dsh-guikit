# Changelog

## 0.2.2

- 收紧 peer 范围：`@deepseek-ai/dsh-tools` 从 `*` 改为 `>=0.1.0-rc.1`。
  原因是 npm 把 `*` 解析到 `latest` 标签，而那个标签还停在远古的 `0.0.1-rc.1`——
  裸装会拉进一份过老的 dsh-tools 盖住 DSH 自带的那份。

## 0.2.1 — 首次发布到 npm

- **修复：中文界面文本回传乱码。** 子进程在没有控制台时（DSH 的 spawn 就是这种），.NET 的
  `[Console]::OutputEncoding` 会回退到系统 ANSI 代码页（中文 Windows = gb2312），
  PowerShell 于是把 GBK 字节写进 stdout，而宿主按 UTF-8 解码——UIA 元素名、窗口标题里的中文
  全部变成 U+FFFD，ASCII 部分正常所以很隐蔽。现在 PRELUDE 第一句就把 stdout 钉死成 UTF-8。
- **修复：硬编码的本机路径。** 截图与编译缓存目录原本写死 `E:\workspace\sage-gui`，
  换台机器直接失败。改为 `%TEMP%\sage-guikit`，可用环境变量 `SAGE_GUIKIT_DIR` 覆盖；
  子进程 cwd 同步跟随该目录（cwd 不存在会让 spawn 直接 ENOENT）。
- 补齐 `engines`、`repository` / `homepage` / `bugs`，加 MIT LICENSE 与中英双语 README。

## 0.2.0 — 未发布

精度与稳定性版本：`gui_uia` 结构化定位（tree / find / invoke / value）、
`gui_screenshot annotate`（坐标网格 + 光标十字准星）、`gui_wait` 轮询验证、
`gui_scroll`，共 9 个工具。

## 0.1.0 — 未发布

六个基础工具：`gui_screen` / `gui_screenshot` / `gui_click` / `gui_type` / `gui_key` / `gui_window`。
