/**
 * dsh-guikit — DSH GUI Toolkit（Windows 桌面控制工具集）v0.5。
 *
 * 十二个模型工具。精度栈四层互补：
 *   结构层 gui_uia     UIA 无障碍树：按 Name/控件类型定位、InvokePattern 直按按钮、
 *                      ValuePattern 直读控件文本（验证输入无需截图）
 *   视觉层 gui_screenshot annotate 模式把坐标网格画进图里（隔行隔列标签防遮挡，
 *                      红色十字准星标记光标），读标签报坐标，DPI 换算误差归零
 *   验证层 gui_verify  语义谓词（元素存在/可用/值相等、窗口存在/bounds）+ 稳定采样，
 *                      返回 satisfied|unsatisfied|unknown —— unknown 绝不可当成功读
 *          gui_wait    像素变化 / 窗口出现轮询
 * 操作层 gui_click / gui_type / gui_key / gui_scroll / gui_window
 *   click/type 回显点击后焦点窗口；输入类工具的回执一律带 delivery.verified=false，
 *   因为「事件送进 OS」不等于「目标有反应」——要结论就得跟一次 gui_verify。
 *
 * 实现统一走 PowerShell 子进程：
 *   - U32.v2.dll 编译缓存（原子写 tmp+Move、完整性校验 >4KB、失败回退内存编译）
 *   - user32 SendInput / SetCursorPos / EnumWindows；UIA 走 UIAutomationClient
 *   - SetProcessDPIAware：坐标一律物理像素，多屏负坐标安全（本机副屏 y=-278）
 *   - Unicode 注入逐字符 SendInput 绕 IME，中文无损
 *
 * 已知边界：UIPI 点不了管理员窗口；锁屏/UAC 安全桌面不可达；
 * clipboard 模式覆盖用户剪贴板；注入前先 activate/点击目标（前台锁会静默吞掉程序化抢焦）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 截图落盘目录 + U32 编译缓存目录。默认在系统临时目录下，可用环境变量覆盖。
const ART = process.env.DSH_GUIKIT_DIR || join(tmpdir(), 'dsh-guikit')

// 这些工具的返回值只代表「已发送」不代表「已生效」，统一挂 delivery 字段。
// 对齐 cua-driver 的 "Sent ... (not verified)" 诚实标注：2026-09-25 实测到
// 点击回执 ok 而界面纹丝不动（Chromium 丢后台 PostMessage、合成光标被抢走），
// 调用方无从判断，只能靠后续验证——所以这里把「未验证」写成返回值的一部分。
const INPUT_EFFECT_TOOLS = new Set(['gui_click', 'gui_drag', 'gui_type', 'gui_key', 'gui_scroll'])

const CS_HELPERS = [
  'using System;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  'public struct POINT { public int X; public int Y; }',
  'public delegate bool EnumProc(IntPtr hWnd, IntPtr lp);',
  '[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '[StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }',
  '[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }',
  'public static class U32 {',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);',
  '  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);',
  '  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();',
  // 每屏 DPI：GetDpiForSystem 只给"系统 DPI"，多屏不同缩放时必须按屏取（本机两屏都 168dpi/1.75）。
  // MonitorFromPoint + MDT_EFFECTIVE_DPI(0) 是唯一可靠路径；shcore.dll 不可用时调用方回 null，不假装 1.0。
  '  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);',
  '  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);',
  '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
  '  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);',
  '  static INPUT MkMouse(uint flags, int mouseData) { var i = new INPUT(); i.type = 0; i.u.mi = new MOUSEINPUT { mouseData = (uint)mouseData, dwFlags = flags }; return i; }',
  // 拖拽必须边走边发移动事件（SetCursorPos 不产生带按键状态的 WM_MOUSEMOVE，目标程序可能不认）。
  // 绝对坐标 + VIRTUALDESK：多屏负坐标也能正确定位。
  '  static INPUT MkMouseAbs(uint flags, int x, int y) {',
  '    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);',
  '    if (vw < 2) vw = 2; if (vh < 2) vh = 2;',
  '    int nx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));',
  '    int ny = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));',
  '    if (nx < 0) nx = 0; if (nx > 65535) nx = 65535;',
  '    if (ny < 0) ny = 0; if (ny > 65535) ny = 65535;',
  '    var i = new INPUT(); i.type = 0;',
  '    i.u.mi = new MOUSEINPUT { dx = nx, dy = ny, dwFlags = flags | 0x8000u | 0x4000u };',
  '    return i;',
  '  }',
  '  static INPUT MkKey(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags }; return i; }',
  '  static uint Send(INPUT[] arr) { return SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT))); }',
  '  public static string Click(int x, int y, string button, int clicks) {',
  '    if (!SetCursorPos(x, y)) return "SetCursorPos failed";',
  '    System.Threading.Thread.Sleep(120);',
  '    uint downF = 0x0002, upF = 0x0004;',
  '    if (button == "right") { downF = 0x0008; upF = 0x0010; } else if (button == "middle") { downF = 0x0020; upF = 0x0040; }',
  '    for (int c = 0; c < clicks; c++) { Send(new INPUT[] { MkMouse(downF, 0), MkMouse(upF, 0) }); System.Threading.Thread.Sleep(60); }',
  '    return "ok";',
  '  }',
  '  public static string Drag(int x1, int y1, int x2, int y2, string button, int steps, int stepDelayMs) {',
  '    if (!SetCursorPos(x1, y1)) return "SetCursorPos failed";',
  '    System.Threading.Thread.Sleep(140);',
  '    uint downF = 0x0002, upF = 0x0004;',
  '    if (button == "right") { downF = 0x0008; upF = 0x0010; } else if (button == "middle") { downF = 0x0020; upF = 0x0040; }',
  '    if (steps < 2) steps = 16; if (steps > 120) steps = 120;',
  '    if (stepDelayMs < 5) stepDelayMs = 16; if (stepDelayMs > 250) stepDelayMs = 250;',
  '    Send(new INPUT[] { MkMouse(downF, 0) });',
  '    System.Threading.Thread.Sleep(110);',
  '    try {',
  '      for (int i = 1; i <= steps; i++) {',
  '        int nx = x1 + (int)Math.Round((double)(x2 - x1) * i / steps);',
  '        int ny = y1 + (int)Math.Round((double)(y2 - y1) * i / steps);',
  '        Send(new INPUT[] { MkMouseAbs(0x0001, nx, ny) });',
  '        System.Threading.Thread.Sleep(stepDelayMs);',
  '      }',
  '      System.Threading.Thread.Sleep(140);',
  '    } finally {',
  '      Send(new INPUT[] { MkMouse(upF, 0) });',
  '    }',
  '    SetCursorPos(x2, y2);',
  '    return "ok";',
  '  }',
  '  public static string ScrollAt(int x, int y, int notches, string direction) {',
  '    if (!SetCursorPos(x, y)) return "SetCursorPos failed";',
  '    System.Threading.Thread.Sleep(140);',
  '    uint flag = (direction == "left" || direction == "right") ? 0x1000u : 0x0800u;',
  '    int sign = (direction == "down" || direction == "left") ? -1 : 1;',
  '    for (int i = 0; i < notches; i++) { Send(new INPUT[] { MkMouse(flag, 120 * sign) }); System.Threading.Thread.Sleep(60); }',
  '    return "ok";',
  '  }',
  '  public static string TypeText(string text) {',
  '    if (string.IsNullOrEmpty(text)) return "empty";',
  '    var list = new List<INPUT>();',
  '    foreach (char ch in text) { list.Add(MkKey(0, ch, 0x0004)); list.Add(MkKey(0, ch, 0x0006)); }',
  '    var arr = list.ToArray(); uint sent = Send(arr);',
  '    return sent == arr.Length ? "ok" : ("partial " + sent + "/" + arr.Length);',
  '  }',
  '  public static string TapKeys(ushort[] vks) {',
  '    if (vks == null || vks.Length == 0) return "empty";',
  '    var list = new List<INPUT>();',
  '    foreach (ushort vk in vks) list.Add(MkKey(vk, 0, 0));',
  '    for (int i = vks.Length - 1; i >= 0; i--) list.Add(MkKey(vks[i], 0, 0x0002));',
  '    var arr = list.ToArray(); uint sent = Send(arr);',
  '    return sent == arr.Length ? "ok" : ("partial " + sent + "/" + arr.Length);',
  '  }',
  '  public static string Activate(IntPtr hWnd) {',
  '    Send(new INPUT[] { MkKey(0x12, 0, 0), MkKey(0x12, 0, 0x0002) });',
  '    System.Threading.Thread.Sleep(60);',
  '    SetForegroundWindow(hWnd);',
  '    System.Threading.Thread.Sleep(150);',
  '    return GetForegroundWindow() == hWnd ? "ok" : "focus-failed";',
  '  }',
  '  public static string FgTitle() {',
  '    var h = GetForegroundWindow();',
  '    var sb = new StringBuilder(512);',
  '    GetWindowText(h, sb, 512);',
  '    return h.ToInt64() + "|" + sb.ToString();',
  '  }',
  '}',
].join('\n')

// 编译缓存按 C# 源码内容哈希命名：源码一改，缓存文件名就变、自动重编。
// （固定 tag + 只查文件存在性会加载到缺少新方法的旧 DLL，报「U32 不包含名为 X 的方法」——踩过一次。）
const DLL_TAG = 'v' + createHash('sha1').update(CS_HELPERS).digest('hex').slice(0, 10)

const PRELUDE = [
  // stdout 一律 UTF-8。子进程在某些环境下 [Console]::OutputEncoding 会是系统 ANSI 代码页
  // （中文 Windows = gb2312），此时回传的中文会被宿主按 UTF-8 解码成 U+FFFD——ASCII 正常，
  // 所以症状很隐蔽。显式钉死，不依赖宿主环境的代码页。
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$OutputEncoding = [Console]::OutputEncoding',
  "$ErrorActionPreference = 'Stop'",
  "New-Item -ItemType Directory -Force -Path '" + ART + "' | Out-Null",
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  "$u32dll = Join-Path '" + ART + "' 'U32." + DLL_TAG + ".dll'",
  '$u32ok = $false',
  'if ((Test-Path $u32dll) -and ((Get-Item $u32dll).Length -gt 4096)) {',
  '  try { Add-Type -Path $u32dll; $u32ok = $true } catch {}',
  '}',
  'if (-not $u32ok) {',
  "  $src = @'",
  CS_HELPERS,
  "'@",
  '  try {',
  '    $tmp = "$u32dll.tmp"',
  '    Remove-Item $tmp -Force -ErrorAction SilentlyContinue',
  '    Add-Type -TypeDefinition $src -OutputAssembly $tmp',
  '    Move-Item $tmp $u32dll -Force',
  '    Add-Type -Path $u32dll',
  '  } catch {',
  '    Add-Type -TypeDefinition $src',
  '  }',
  '}',
  '[U32]::SetProcessDPIAware() | Out-Null',
].join('\n')

function psScript(argsJson, body) {
  return PRELUDE + "\n$g = '" + String(argsJson).replace(/'/g, "''") + "' | ConvertFrom-Json\n" + body
}

function parseKeySpec(spec) {
  const NAMED = { enter: 0x0D, tab: 0x09, esc: 0x1B, escape: 0x1B, space: 0x20, backspace: 0x08, delete: 0x2E, del: 0x2E, insert: 0x2D, home: 0x24, end: 0x23, pgup: 0x21, pgdn: 0x22, pageup: 0x21, pagedown: 0x22, left: 0x25, up: 0x26, right: 0x27, down: 0x28, printscreen: 0x2C, capslock: 0x14, menu: 0x5D }
  const parts = String(spec).toLowerCase().split('+').map(s => s.trim()).filter(Boolean)
  const vks = []
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') vks.push(0x11)
    else if (p === 'alt') vks.push(0x12)
    else if (p === 'shift') vks.push(0x10)
    else if (p === 'win' || p === 'lwin') vks.push(0x5B)
    else if (p === 'rwin') vks.push(0x5C)
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(p)) vks.push(0x70 + (parseInt(p.slice(1), 10) - 1))
    else if (/^[a-z]$/.test(p)) vks.push(0x41 + (p.charCodeAt(0) - 97))
    else if (/^[0-9]$/.test(p)) vks.push(0x30 + parseInt(p, 10))
    else if (NAMED[p] !== undefined) vks.push(NAMED[p])
    else throw new Error('unknown key: ' + p)
  }
  if (vks.length === 0) throw new Error('empty key spec')
  return vks
}

// gui_click.verify 的语义校验（schema 只管类型，这里管「mode 与字段搭不搭」）。
function validateVerify(v, label) {
  if (v === null || typeof v !== 'object') throw new Error(label + ' must be an object')
  const mode = String(v.mode || '')
  if (mode !== 'element' && mode !== 'window') throw new Error(label + '.mode must be element|window')
  if (mode === 'element' && !v.name && !v.elType) throw new Error(label + ' (element) needs name or elType')
  if (mode === 'window' && !v.title && typeof v.handle !== 'number') throw new Error(label + ' (window) needs title or handle')
  if (v.exists === false) throw new Error(label + ' cannot assert absence: assert what should be present instead.')
  const b = ['boundsX', 'boundsY', 'boundsW', 'boundsH'].filter((k) => typeof v[k] === 'number')
  if (b.length !== 0 && b.length !== 4) throw new Error(label + ' bounds needs all of boundsX/boundsY/boundsW/boundsH')
}

// per-call 目标窗口解析（gui_click / gui_drag 共用）：$g.window（标题子串或 handle）→ $hwnd + rect + scale。
// 变量一律带 w 前缀，避免与调用方后面要用的 $r/$p/$res 撞名（PS 变量名大小写不敏感）。
const WINDOW_TARGET_PS = [
  '$space = "virtual-desktop"; if ($g.space) { $space = [string]$g.space }',
  '$hwnd = [IntPtr]::Zero; $winTitle = ""; $wscale = 1.0; $inside = $null; $origin = $null; $target = $null',
  'if ($null -ne $g.window) {',
  '  if ($g.window -is [string]) {',
  '    Add-Type -AssemblyName UIAutomationClient',
  '    Add-Type -AssemblyName UIAutomationTypes',
  '    $wc = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Window)',
  '    $wins = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $wc)',
  '    foreach ($w in $wins) { try { if ($w.Current.Name -like ("*" + [string]$g.window + "*")) { $hwnd = [IntPtr][int64]$w.Current.NativeWindowHandle; break } } catch {} }',
  '  } else { $hwnd = [IntPtr][int64]$g.window }',
  '}',
  'if ($null -ne $g.window) {',
  // 窗口不存在就明确报错，绝不拿猜的坐标去点（标题与句柄都可能过期）。
  '  if ($hwnd -eq [IntPtr]::Zero -or -not [U32]::IsWindow($hwnd)) { @{ error="window not found (no window matching that title/handle)" } | ConvertTo-Json -Compress; exit }',
  '  $r = New-Object RECT; [void][U32]::GetWindowRect($hwnd, [ref]$r)',
  // 窗口「还在但正在关」时 rect 会是 0x0，按它换算出来的坐标是垃圾 —— 与其点错，不如报错。
  '  if (($r.Right - $r.Left) -lt 1 -or ($r.Bottom - $r.Top) -lt 1) { @{ error=("window " + $hwnd.ToInt64() + " has no usable rect (it may be closing)") } | ConvertTo-Json -Compress; exit }',
  '  $sb = New-Object System.Text.StringBuilder 512; [void][U32]::GetWindowText($hwnd, $sb, 512); $winTitle = $sb.ToString()',
  '  $origin = @{ x=$r.Left; y=$r.Top }',
  '  $target = @{ handle=$hwnd.ToInt64(); title=$winTitle }',
  // scale 口径与 gui_window_shot 完全一致：DPI-unaware 窗口（GetDpiForWindow=96）时 >1。
  '  $wdpi = 96; $sysDpi = 96',
  '  try { $wdpi = [U32]::GetDpiForWindow($hwnd); $sysDpi = [U32]::GetDpiForSystem() } catch {}',
  '  if ($wdpi -lt 1) { $wdpi = 96 }; if ($sysDpi -lt 1) { $sysDpi = 96 }',
  '  $wscale = [Math]::Round($sysDpi / $wdpi, 3)',
  '}',
  'if ($space -eq "window-local" -and $null -eq $g.window) { @{ error="space=window-local needs window (title substring or handle)" } | ConvertTo-Json -Compress; exit }',
]

// gui_verify 的三态断言实现 —— 与 gui_click 的 verify 参数**共用同一份**。调用方先设 `$v = <断言参数对象>`。
// 两处各写一份必然漂移（ControlView/RawView 那次就埋下过「发现得到、验证不了」），所以抽成一处。
// 所有临时变量加 v 前缀：PowerShell 变量名大小写不敏感，与调用方的 $r/$p/$res 撞名会静默串值。
const VERIFY_ASSERTION_PS = [
  '$vtimeout = 5000; if ($v.timeoutMs) { $vtimeout = [int]$v.timeoutMs }; if ($vtimeout -gt 55000) { $vtimeout = 55000 }; if ($vtimeout -lt 200) { $vtimeout = 200 }',
  '$vneed = 2; if ($v.stableSamples) { $vneed = [int]$v.stableSamples }; if ($vneed -lt 1) { $vneed = 1 }; if ($vneed -gt 5) { $vneed = 5 }',
  '$vinterval = 250; if ($v.intervalMs) { $vinterval = [Math]::Max(80, [int]$v.intervalMs) }',
  '$vmode = [string]$v.mode',
  'Add-Type -AssemblyName UIAutomationClient',
  'Add-Type -AssemblyName UIAutomationTypes',
  // 与 gui_uia 同源：RawViewWalker + depth 40（ControlView 是塌缩视图，看不到 IsControlElement=false
  // 的 Text 标签；gui_uia / gui_locate 命中的元素必须能被同一个树验证）。
  '$vwalkMax = 4000; $vdepthMax = 40',
  'function Find-VWin {',
  '  if ($null -ne $v.handle) { try { return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$v.handle) } catch { return $null } }',
  '  if ($v.title) {',
  '    $vwc = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Window)',
  '    $vwins = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $vwc)',
  '    foreach ($vw in $vwins) { try { if ($vw.Current.Name -like ("*" + $v.title + "*")) { return $vw } } catch {} }',
  '    return $null',
  '  }',
  '  return [System.Windows.Automation.AutomationElement]::FromForeground()',
  '}',
  '$vwalker = [System.Windows.Automation.TreeWalker]::RawViewWalker',
  'function Find-VEl($root) {',
  '  $script:vfound = $null; $script:vseen = 0',
  '  function WalkV($el, $d) {',
  '    if ($d -gt $vdepthMax -or $null -ne $script:vfound -or $script:vseen -gt $vwalkMax) { return }',
  '    try { $vc = $vwalker.GetFirstChild($el) } catch { return }',
  '    while ($null -ne $vc) {',
  '      $script:vseen = $script:vseen + 1',
  '      try {',
  '        $vnm = [string]$vc.Current.Name',
  '        $vtn = [string]$vc.Current.ControlType.ProgrammaticName',
  '        $vtn = $vtn.Replace("ControlType.", "")',
  '        $vnameOk = (-not $v.name) -or ($vnm -like ("*" + $v.name + "*"))',
  '        $vtypeOk = (-not $v.elType) -or ($vtn -like ("*" + $v.elType + "*"))',
  '        if ($vnameOk -and $vtypeOk) { $script:vfound = $vc; return }',
  '      } catch {}',
  '      WalkV $vc ($d + 1)',
  '      if ($null -ne $script:vfound) { return }',
  '      $vc = $vwalker.GetNextSibling($vc)',
  '    }',
  '  }',
  '  WalkV $root 0',
  '  return $script:vfound',
  '}',
  '$vsw = [System.Diagnostics.Stopwatch]::StartNew()',
  '$vstreak = 0; $vtries = 0; $vok = $null; $vwhy = "not evaluated"; $vobs = $null; $vdecided = $false',
  'while ($vsw.ElapsedMilliseconds -lt $vtimeout) {',
  '  $vtries = $vtries + 1',
  '  $vok = $null; $vobs = $null',
  '  $vtarget = Find-VWin',
  '  if ($null -eq $vtarget) { $vwhy = "target window not found" }',
  '  elseif ($vmode -eq "window") {',
  '    $vr = $vtarget.Current.BoundingRectangle',
  '    $vobs = @{ title=[string]$vtarget.Current.Name; x=[int]$vr.X; y=[int]$vr.Y; w=[int]$vr.Width; h=[int]$vr.Height }',
  '    if ($null -ne $v.boundsW) {',
  '      $vtol = 8; if ($v.tolerancePx) { $vtol = [int]$v.tolerancePx }',
  '      $vdx = [Math]::Abs([int]$vr.X - [int]$v.boundsX); $vdy = [Math]::Abs([int]$vr.Y - [int]$v.boundsY)',
  '      $vdw = [Math]::Abs([int]$vr.Width - [int]$v.boundsW); $vdh = [Math]::Abs([int]$vr.Height - [int]$v.boundsH)',
  '      $vok = ($vdx -le $vtol) -and ($vdy -le $vtol) -and ($vdw -le $vtol) -and ($vdh -le $vtol)',
  '      $vwhy = "bounds delta " + $vdx + "/" + $vdy + "/" + $vdw + "/" + $vdh + " tol " + $vtol',
  '    } else { $vok = $true; $vwhy = "window present" }',
  '  }',
  '  else {',
  '    $vel = Find-VEl $vtarget',
  '    if ($null -eq $vel) { $vwhy = "element not found (UIA walk is not exhaustive)" }',
  '    else {',
  '      $vok = $true; $vwhy = "element found"',
  '      $vobs = @{ name=[string]$vel.Current.Name; type=([string]$vel.Current.ControlType.ProgrammaticName).Replace("ControlType.", ""); enabled=$vel.Current.IsEnabled }',
  '      if ($v.enabled -eq $true -and -not $vel.Current.IsEnabled) { $vok = $false; $vwhy = "element is disabled" }',
  '      if ($null -ne $v.valueEquals) {',
  '        $vval = $null',
  '        try { $vval = ($vel.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value } catch {}',
  '        $vobs.value = $vval',
  '        if ($null -eq $vval) { $vok = $null; $vwhy = "element exposes no ValuePattern" }',
  '        elseif ($vval -ne [string]$v.valueEquals) { $vok = $false; $vwhy = "value differs from expectation" }',
  '        else { $vwhy = "value matches" }',
  '      }',
  '    }',
  '  }',
  '  if ($vok -eq $true) { $vstreak = $vstreak + 1 } else { $vstreak = 0 }',
  '  if ($vstreak -ge $vneed) { $vdecided = $true; break }',
  '  Start-Sleep -Milliseconds $vinterval',
  '}',
  '$vverdict = "unsatisfied"',
  'if ($vdecided) { $vverdict = "satisfied" } elseif ($null -eq $vok) { $vverdict = "unknown" }',
  '$vres = @{ verdict=$vverdict; mode=$vmode; elapsedMs=$vsw.ElapsedMilliseconds; tries=$vtries; streak=$vstreak; required=$vneed; detail=$vwhy; observed=$vobs }',
]

export const name = 'dsh-guikit'

export const inject = ['tools', 'subprocess', 'timer']

export function apply(ctx) {
  const subprocess = ctx.subprocess
  const timer = ctx.timer
  let pwshPath = null

  // 子进程 cwd 必须是已存在的目录，否则 spawn 直接 ENOENT。
  let workDir = ART
  try { mkdirSync(ART, { recursive: true }) } catch (e) { workDir = process.cwd() }

  async function runPs(script, signal, timeoutMs) {
    if (pwshPath === null) {
      try { pwshPath = await subprocess.resolveExecutable('pwsh') } catch (e) { pwshPath = 'pwsh' }
    }
    const handle = subprocess.spawn({
      argv: [pwshPath, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      cwd: workDir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 393216 }, stderr: { maxBytes: 131072 } },
      graceMs: 3000,
      signal: signal,
    })
    let timedOut = false
    const cancelTimer = timer.timeout(() => { timedOut = true; handle.terminate() }, timeoutMs)
    try {
      const outcome = await handle.done
      const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
      const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
      return { exitCode: outcome.exitCode, stdout: stdout, stderr: stderr, timedOut: timedOut }
    } finally {
      cancelTimer()
    }
  }

  function jsonOut(run, toolName) {
    const raw = (run.stdout || '').trim()
    try { return JSON.parse(raw) } catch (e) {
      throw new Error(toolName + ': pwsh exit=' + run.exitCode + ' no JSON. stderr tail: ' + (run.stderr || '').slice(-500))
    }
  }

  function registerGuiTool(def, build, timeoutMs) {
    ctx.tools.register(defineTool({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: timeoutMs,
      execute: async (args, exec) => {
        const built = build(args)
        const run = await runPs(psScript(built.json, built.body), exec.signal, timeoutMs)
        if (run.timedOut) throw new Error(def.name + ' timed out after ' + timeoutMs + 'ms')
        const value = jsonOut(run, def.name)
        if (value && value.error) throw new Error(String(value.error))
        if (INPUT_EFFECT_TOOLS.has(def.name) && value !== null && typeof value === 'object') {
          // sent 恒 true（事件确实送进了 OS）；verified 只认工具内 verify 断言的 satisfied ——
          // 三态里只有 satisfied 是「已生效」的证据，unsatisfied / unknown 都保持 false。
          const vres = value.verify
          value.delivery = {
            sent: true,
            verified: !!(vres && vres.verdict === 'satisfied'),
            note: vres
              ? 'Input was SENT; the in-call verify assertion returned verdict=' + vres.verdict + ' (only satisfied counts as verified).'
              : 'Input was SENT, not confirmed: the events reached the OS, which does not mean the target reacted. Confirm with gui_verify (element/window) or gui_wait (pixel) before trusting this result.',
          }
        }
        return value
      },
    }))
  }

  registerGuiTool({
    name: 'gui_screen',
    description: 'List monitor layout of this Windows PC: per-screen bounds in physical pixels, virtual desktop rect, current cursor position. Multi-monitor: secondary screens may have negative X/Y. Call this before any coordinate-based tool.',
    parameters: {},
  }, () => ({ json: '{}', body: [
    '$screens = @()',
    '$i = 0',
    'foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {',
    '  $b = $s.Bounds',
    '  $pt = New-Object POINT',
    '  $pt.X = [int]($b.X + [Math]::Floor($b.Width / 2)); $pt.Y = [int]($b.Y + [Math]::Floor($b.Height / 2))',
    '  $mon = [U32]::MonitorFromPoint($pt, 2)',
    '  $dx = [uint32]0; $dy = [uint32]0; $hr = -1',
    '  try { $hr = [U32]::GetDpiForMonitor($mon, 0, [ref]$dx, [ref]$dy) } catch { $hr = -1 }',
    '  $scale = $null; $logical = $null',
    '  if ($hr -eq 0 -and $dx -gt 0) { $scale = [Math]::Round($dx / 96.0, 3); $logical = @{ w=[int][Math]::Round($b.Width * 96.0 / $dx); h=[int][Math]::Round($b.Height * 96.0 / $dx) } }',
    '  $screens += @{ index=$i; device=$s.DeviceName; primary=$s.Primary; x=$b.X; y=$b.Y; w=$b.Width; h=$b.Height; physical_rect=@{ x=$b.X; y=$b.Y; w=$b.Width; h=$b.Height }; logical_rect=$logical; dpi_scale=$scale; is_primary=[bool]$s.Primary; display_id=[string]$s.DeviceName }',
    '  $i++',
    '}',
    '$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$p = New-Object POINT',
    '[void][U32]::GetCursorPos([ref]$p)',
    '$origin = @{ x=$vs.X; y=$vs.Y }',
    '@{ screens=$screens; virtual=@{ x=$vs.X; y=$vs.Y; w=$vs.Width; h=$vs.Height }; virtual_desktop_origin=$origin; space="virtual-desktop-physical"; cursor=@{ x=$p.X; y=$p.Y } } | ConvertTo-Json -Compress -Depth 6',
  ].join('\n') }), 20000)

  registerGuiTool({
    name: 'gui_screenshot',
    description: 'Capture the Windows screen to a PNG file and return its path (view it with read_image). Give a region (x,y,w,h physical pixels) OR a screen index, or nothing for the whole virtual desktop. For a single window use gui_window_shot. Returns space/origin/image_px/scale, so an image pixel maps to a virtual-desktop physical pixel as origin + image_px * scale. annotate=true draws a coordinate grid with labels at every 2nd intersection (read the labels and report exact click coordinates - zero DPI math), an opaque ruler along the top and left edges, a bottom-left watermark carrying origin/space/scale/region/step, and a red crosshair at the current cursor position. Passive: moves nothing.',
    parameters: {
      screen: { type: 'number', description: 'Monitor index from gui_screen' },
      x: { type: 'number', description: 'Region left (virtual-desktop physical px)' },
      y: { type: 'number', description: 'Region top' },
      w: { type: 'number', description: 'Region width' },
      h: { type: 'number', description: 'Region height' },
      annotate: { type: 'boolean', description: 'Draw coordinate grid + cursor crosshair onto the image' },
      step: { type: 'number', description: 'Grid spacing px (default 120; auto-coarsens for large regions)' },
    },
  }, (args) => ({ json: JSON.stringify(args), body: [
    '$b = $null',
    'if ($null -ne $g.x -and $null -ne $g.y) { $b = @{ x=[int]$g.x; y=[int]$g.y; w=[int]$g.w; h=[int]$g.h } }',
    'elseif ($null -ne $g.screen) { $s = [System.Windows.Forms.Screen]::AllScreens[[int]$g.screen]; $b = @{ x=$s.Bounds.X; y=$s.Bounds.Y; w=$s.Bounds.Width; h=$s.Bounds.Height } }',
    'else { $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen; $b = @{ x=$vs.X; y=$vs.Y; w=$vs.Width; h=$vs.Height } }',
    'if ($b.w -lt 1 -or $b.h -lt 1 -or $b.w -gt 8000 -or $b.h -gt 4000) { @{ error="bad region" } | ConvertTo-Json -Compress; exit }',
    '$stamp = Get-Date -Format "yyyyMMdd-HHmmss"',
    '$path = Join-Path "' + ART + '" ("shot-" + $stamp + ".png")',
    '$bmp = New-Object System.Drawing.Bitmap([int]$b.w, [int]$b.h)',
    '$gr = [System.Drawing.Graphics]::FromImage($bmp)',
    '$gr.CopyFromScreen([int]$b.x, [int]$b.y, 0, 0, (New-Object System.Drawing.Size([int]$b.w, [int]$b.h)))',
    'if ($g.annotate) {',
    '  $step = 120; if ($g.step) { $step = [int]$g.step }; if ($step -lt 50) { $step = 50 }',
    '  if (([int]$b.w * [int]$b.h) -gt 5000000 -and $step -lt 200) { $step = 240 }',
    '  $baseX = [int]$b.x; $baseY = [int]$b.y',
    '  $gridPen = New-Object System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::FromArgb(110, 0, 235, 235)), 1',
    // 标尺：每个网格列/行在图的顶边与左边各画一条 14px 不透明刻度（同色相、alpha=255、宽 2）。
    // 网格线、刻度、标签共用同一个整数图内坐标（$lx/$ly 每个交点只算一次）——分头各算一遍
    // 正是 0.5.1「标签与网格线有递增偏差」的成因。
    '  $tickPen = New-Object System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::FromArgb(255, 0, 235, 235)), 2',
    '  $lblFont = New-Object System.Drawing.Font -ArgumentList Consolas, 12, ([System.Drawing.FontStyle]::Bold)',
    '  $bgBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(165, 0, 0, 0))',
    '  $txtBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 130, 255, 130))',
    '  $startX = [Math]::Ceiling($baseX / $step) * $step',
    '  $startY = [Math]::Ceiling($baseY / $step) * $step',
    '  $ci = 0',
    '  for ($gx = $startX; $gx -le $baseX + [int]$b.w; $gx += $step) {',
    '    $lx = [int]($gx - $baseX)',
    '    $gr.DrawLine($gridPen, $lx, 0, $lx, [int]$b.h)',
    '    $gr.DrawLine($tickPen, $lx, 0, $lx, 13)',
    '    $ri = 0',
    '    for ($gy = $startY; $gy -le $baseY + [int]$b.h; $gy += $step) {',
    '      $ly = [int]($gy - $baseY)',
    '      if ($ci -eq 0) { $gr.DrawLine($gridPen, 0, $ly, [int]$b.w, $ly); $gr.DrawLine($tickPen, 0, $ly, 13, $ly) }',
    '      if (($ci % 2 -eq 0) -and ($ri % 2 -eq 0)) {',
    '        $text = "$gx,$gy"',
    '        $sz = $gr.MeasureString($text, $lblFont)',
    '        $lw = [int]$sz.Width + 6; $lh = [int]$sz.Height + 2',
    '        $tx = $lx + 3; $ty = $ly + 2',
    '        if ($tx + $lw -gt [int]$b.w) { $tx = $lx - $lw - 3 }',
    '        if ($ty + $lh -gt [int]$b.h) { $ty = $ly - $lh - 2 }',
    '        [void]$gr.FillRectangle($bgBrush, $tx, $ty, $lw, $lh)',
    '        $gr.DrawString($text, $lblFont, $txtBrush, $tx, $ty)',
    '      }',
    '      $ri++',
    '    }',
    '    $ci++',
    '  }',
    '  $cp = New-Object POINT',
    '  [void][U32]::GetCursorPos([ref]$cp)',
    '  $cx = $cp.X - $baseX; $cy = $cp.Y - $baseY',
    '  if ($cx -ge 0 -and $cy -ge 0 -and $cx -lt [int]$b.w -and $cy -lt [int]$b.h) {',
    '    $redPen = New-Object System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::FromArgb(230, 255, 60, 60)), 2',
    '    [void]$gr.DrawEllipse($redPen, $cx - 16, $cy - 16, 32, 32)',
    '    $gr.DrawLine($redPen, $cx - 28, $cy, $cx + 28, $cy)',
    '    $gr.DrawLine($redPen, $cx, $cy - 28, $cx, $cy + 28)',
    '    $redPen.Dispose()',
    '  }',
    // 水印放左下角（放左上会盖住顶部标尺），且最后画：模型/探针都能从图里读出 origin/space/scale/region/step。
    '  $wmText = "origin=(" + $baseX + "," + $baseY + ") space=virtual-desktop scale=1 region=" + [int]$b.w + "x" + [int]$b.h + " step=" + $step',
    '  $wsz = $gr.MeasureString($wmText, $lblFont)',
    '  $ww = [Math]::Min([int]$wsz.Width + 6, [int]$b.w)',
    '  $wy = [Math]::Max(0, [int]$b.h - 24)',
    '  $wmBg = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 0, 0, 0))',
    '  [void]$gr.FillRectangle($wmBg, 0, $wy, $ww, [Math]::Min(24, [int]$b.h))',
    '  $gr.DrawString($wmText, $lblFont, $txtBrush, 3, [Math]::Max(0, [int]$b.h - 22))',
    '  $wmBg.Dispose()',
    '  $gridPen.Dispose(); $tickPen.Dispose(); $lblFont.Dispose(); $bgBrush.Dispose(); $txtBrush.Dispose()',
    '}',
    '$gr.Dispose()',
    '$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$iw = $bmp.Width; $ih = $bmp.Height',
    '$bmp.Dispose()',
    '@{ path=$path; x=[int]$b.x; y=[int]$b.y; w=[int]$b.w; h=[int]$b.h; bytes=(Get-Item $path).Length; space="virtual-desktop-physical"; origin=@{ x=[int]$b.x; y=[int]$b.y }; image_px=@{ w=$iw; h=$ih }; scale=1; note="image pixel + origin = virtual-desktop physical pixel (scale 1)" } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n') }), 25000)

  // 单独成工具、脚本写瘦的理由：把「枚举窗口标题 + GetWindowRect + PrintWindow + 画网格」
  // 全塞进 gui_screenshot 一个脚本时，Windows Defender 会经 AMSI 直接拦（「此脚本包含恶意内容」，
  // 实测稳定复现、3/3）。拆出来并压到极简形态后不再被拦。
  registerGuiTool({
    name: 'gui_window_shot',
    description: 'Capture ONE window to a PNG file and return its path (view it with read_image). Target by window (title substring, topmost match) or handle (from gui_window list; takes precedence). Uses PrintWindow, so the window does NOT need to be on top - it still captures correctly when partly covered, and it never activates or moves anything. Returns space/origin/scale/image_px: the image is window-local pixels, and screen = origin + image * scale (scale is 1 for DPI-aware windows and >1 for DPI-unaware ones, whose content is rendered at logical scale). annotate=true draws the coordinate grid, an opaque ruler along the top and left edges and a bottom-left watermark (origin/space/scale/region/step), all labelled in absolute screen px. A minimized window renders black. Passive: moves nothing.',
    parameters: {
      window: { type: 'string', description: 'Window title substring (topmost visible match)' },
      handle: { type: 'number', description: 'Window handle from gui_window list' },
      annotate: { type: 'boolean', description: 'Draw the coordinate grid onto the image' },
      step: { type: 'number', description: 'Grid spacing px (default 120)' },
    },
  }, (args) => {
    if (typeof args.handle !== 'number' && typeof args.window !== 'string') throw new Error('gui_window_shot needs window or handle')
    return { json: JSON.stringify(args), body: [
      '$hwnd = [IntPtr]::Zero',
      'if ($null -ne $g.handle) { $hwnd = [IntPtr][int64]$g.handle }',
      'else {',
      '  Add-Type -AssemblyName UIAutomationClient',
      '  Add-Type -AssemblyName UIAutomationTypes',
      '  $c = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Window)',
      '  $ws = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $c)',
      '  foreach ($x in $ws) { try { if ($x.Current.Name -like ("*" + [string]$g.window + "*")) { $hwnd = [IntPtr][int64]$x.Current.NativeWindowHandle; break } } catch {} }',
      '}',
      'if ($hwnd -eq [IntPtr]::Zero) { @{ error="window not found" } | ConvertTo-Json -Compress; exit }',
      '$r = New-Object RECT',
      '[void][U32]::GetWindowRect($hwnd, [ref]$r)',
      '$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top',
      // DPI-unaware 的窗口（WinForms 默认、部分 CEF 壳）在 175% 缩放下，GetWindowRect 给物理尺寸，
      // 但 PrintWindow 按它自己的逻辑尺度渲染——内容只铺在左上角，图坐标不再 1:1 对应物理像素。
      // 报一个 scale 出来，模型就能换算：screen = origin + image * scale。
      '$dpi = 96; $sysDpi = 96',
      'try { $dpi = [U32]::GetDpiForWindow($hwnd); $sysDpi = [U32]::GetDpiForSystem() } catch {}',
      'if ($dpi -lt 1) { $dpi = 96 }; if ($sysDpi -lt 1) { $sysDpi = 96 }',
      '$scale = [Math]::Round($sysDpi / $dpi, 3)',
      'if ($w -lt 1 -or $h -lt 1) { @{ error=("window handle " + $hwnd.ToInt64() + " has no usable rect (it may have closed)") } | ConvertTo-Json -Compress; exit }',
      'if ($w -gt 8000 -or $h -gt 4000) { @{ error=("bad window size " + $w + "x" + $h) } | ConvertTo-Json -Compress; exit }',
      '$path = Join-Path "' + ART + '" ("win-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".png")',
      '$bmp = New-Object System.Drawing.Bitmap($w, $h)',
      '$gr = [System.Drawing.Graphics]::FromImage($bmp)',
      '$hdc = $gr.GetHdc()',
      '$pw = $false',
      'try { $pw = [U32]::PrintWindow($hwnd, $hdc, 2) } finally { $gr.ReleaseHdc($hdc) }',
      '$mode = "printwindow"',
      'if (-not $pw) { $gr.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h))); $mode = "screen" }',
      'if ($g.annotate) {',
      '  $st = 120; if ($g.step) { $st = [int]$g.step }; if ($st -lt 50) { $st = 50 }',
      '  $pen = New-Object System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::FromArgb(110, 0, 235, 235)), 1',
      // 标尺与网格线共用同一个整数图内坐标（$lx/$ly）；标签写该像素真正对应的绝对屏幕坐标
      // = origin + 图内 × scale（scale≠1 的 DPI-unaware 窗口下，标签才不是假的）。
      '  $tick = New-Object System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::FromArgb(255, 0, 235, 235)), 2',
      '  $fnt = New-Object System.Drawing.Font -ArgumentList Consolas, 12, ([System.Drawing.FontStyle]::Bold)',
      '  $bg = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(165, 0, 0, 0))',
      '  $fg = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 130, 255, 130))',
      '  $ci = 0',
      '  for ($gx = [Math]::Ceiling($r.Left / $st) * $st; $gx -le $r.Left + $w; $gx += $st) {',
      '    $lx = [int]($gx - $r.Left)',
      '    $gr.DrawLine($pen, $lx, 0, $lx, $h)',
      '    $gr.DrawLine($tick, $lx, 0, $lx, 13)',
      '    $ri = 0',
      '    for ($gy = [Math]::Ceiling($r.Top / $st) * $st; $gy -le $r.Top + $h; $gy += $st) {',
      '      $ly = [int]($gy - $r.Top)',
      '      if ($ci -eq 0) { $gr.DrawLine($pen, 0, $ly, $w, $ly); $gr.DrawLine($tick, 0, $ly, 13, $ly) }',
      '      if (($ci % 2) -eq 0 -and ($ri % 2) -eq 0) {',
      '        $ax = [int]($r.Left + $lx * $scale); $ay = [int]($r.Top + $ly * $scale)',
      '        $t = "$ax,$ay"; $sz = $gr.MeasureString($t, $fnt)',
      '        $lw = [int]$sz.Width + 6; $lh = [int]$sz.Height + 2',
      '        $px = $lx + 3; $py = $ly + 2',
      '        if ($px + $lw -gt $w) { $px = $lx - $lw - 3 }',
      '        if ($py + $lh -gt $h) { $py = $ly - $lh - 2 }',
      '        [void]$gr.FillRectangle($bg, $px, $py, $lw, $lh)',
      '        $gr.DrawString($t, $fnt, $fg, $px, $py)',
      '      }',
      '      $ri++',
      '    }',
      '    $ci++',
      '  }',
      '  $wm = "origin=(" + $r.Left + "," + $r.Top + ") space=window-local scale=" + $scale + " region=" + $w + "x" + $h + " step=" + $st',
      '  $wsz = $gr.MeasureString($wm, $fnt)',
      '  $ww = [Math]::Min([int]$wsz.Width + 6, $w)',
      '  $wy = [Math]::Max(0, $h - 24)',
      '  $wmBg = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 0, 0, 0))',
      '  [void]$gr.FillRectangle($wmBg, 0, $wy, $ww, [Math]::Min(24, $h))',
      '  $gr.DrawString($wm, $fnt, $fg, 3, [Math]::Max(0, $h - 22))',
      '  $wmBg.Dispose()',
      '  $pen.Dispose(); $tick.Dispose(); $fnt.Dispose(); $bg.Dispose(); $fg.Dispose()',
      '}',
      '$gr.Dispose()',
      '$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)',
      '$iw = $bmp.Width; $ih = $bmp.Height',
      '$bmp.Dispose()',
      '@{ path=$path; x=$r.Left; y=$r.Top; w=$w; h=$h; scale=$scale; bytes=(Get-Item $path).Length; capture=$mode; handle=$hwnd.ToInt64(); space="window-local"; origin=@{ x=$r.Left; y=$r.Top }; image_px=@{ w=$iw; h=$ih } } | ConvertTo-Json -Compress -Depth 4',
    ].join('\n') }
  }, 25000)

  registerGuiTool({
    name: 'gui_click',
    description: 'Move the REAL mouse cursor to (x,y) and click. Takes over the user mouse briefly. Coordinates are virtual-desktop physical pixels by default (secondary screens negative - get them from gui_screen or annotated gui_screenshot); with space=window-local they are window-local image pixels as seen in gui_window_shot, converted in-process to absolute screen coordinates. `window` names the target explicitly instead of relying on whatever is in the foreground. button left(default)/right/middle; clicks 1=single 2=double 3=triple. The receipt reports space/origin/scale/requested/absolute/insideWindow/target so a misdirected click is visible immediately, and delivery.verified turns true only when an optional `verify` assertion returns satisfied.',
    parameters: {
      x: { type: 'number', required: true, description: 'Target X (virtual-desktop physical px, or window-local px when space=window-local)' },
      y: { type: 'number', required: true, description: 'Target Y (same space as x)' },
      button: { type: 'string', description: 'left | right | middle' },
      clicks: { type: 'number', description: '1 single, 2 double, 3 triple' },
      window: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Per-call target: window title substring, or a handle from gui_window. Required when space=window-local; when given it is also used for the insideWindow check.' },
      space: { type: 'string', description: 'virtual-desktop (default) | window-local. window-local interprets x/y as gui_window_shot image pixels: absolute = origin + round(local * scale), with scale as reported by gui_window_shot (>1 for DPI-unaware windows).' },
      verify: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional assertion run right after the click, in the same pwsh process (identical semantics to gui_verify). delivery.verified is true only for verdict=satisfied.',
        properties: {
          mode: { type: 'string', required: true, description: 'element | window' },
          title: { type: 'string', description: 'window mode: window title substring; element mode: which window to search' },
          handle: { type: 'number', description: 'or target window handle' },
          name: { type: 'string', description: 'element mode: element Name substring' },
          elType: { type: 'string', description: 'element mode: control type substring' },
          enabled: { type: 'boolean', description: 'element mode: also require IsEnabled=true' },
          valueEquals: { type: 'string', description: 'element mode: also require the ValuePattern text to equal this' },
          exists: { type: 'boolean', description: 'Must be true or omitted; absence is not provable' },
          boundsX: { type: 'number', description: 'window mode: expected X' },
          boundsY: { type: 'number', description: 'window mode: expected Y' },
          boundsW: { type: 'number', description: 'window mode: expected width' },
          boundsH: { type: 'number', description: 'window mode: expected height' },
          tolerancePx: { type: 'number', description: 'window mode: allowed bounds drift (default 8)' },
          timeoutMs: { type: 'number', description: 'Default 5000, cap 55000' },
          stableSamples: { type: 'number', description: 'Consecutive agreeing checks required (default 2, 1-5)' },
          intervalMs: { type: 'number', description: 'Poll interval (default 250, min 80)' },
        },
      },
    },
  }, (args) => {
    if (typeof args.x !== 'number' || typeof args.y !== 'number') throw new Error('gui_click needs numeric x and y')
    const space = args.space === undefined ? 'virtual-desktop' : String(args.space)
    if (space !== 'virtual-desktop' && space !== 'window-local') throw new Error('gui_click space must be virtual-desktop|window-local')
    if (space === 'window-local' && (args.window === undefined || args.window === null)) throw new Error('gui_click space=window-local needs window (title substring or handle)')
    if (args.verify !== undefined) validateVerify(args.verify, 'gui_click verify')
    const payload = { x: args.x, y: args.y, button: args.button || 'left', clicks: Math.max(1, Math.min(3, args.clicks || 1)), space: space }
    if (args.window !== undefined && args.window !== null) payload.window = args.window
    if (args.verify !== undefined) payload.verify = args.verify
    return { json: JSON.stringify(payload), body: [
      ...WINDOW_TARGET_PS,
      'if ($space -eq "window-local") {',
      '  $absX = [int]($r.Left + [Math]::Round([double]$g.x * $wscale, 0))',
      '  $absY = [int]($r.Top + [Math]::Round([double]$g.y * $wscale, 0))',
      '} else { $absX = [int]$g.x; $absY = [int]$g.y }',
      // insideWindow 按**窗口物理 rect** 判（不是图像尺寸）：DPI-unaware 窗口的图远大于真实内容区。
      'if ($hwnd -ne [IntPtr]::Zero) { $inside = (($absX -ge $r.Left) -and ($absX -lt $r.Right) -and ($absY -ge $r.Top) -and ($absY -lt $r.Bottom)) }',
      '$res = [U32]::Click($absX, $absY, [string]$g.button, [int]$g.clicks)',
      'Start-Sleep -Milliseconds 150',
      '$p = New-Object POINT',
      '[void][U32]::GetCursorPos([ref]$p)',
      '$fgParts = ([U32]::FgTitle()).Split([char]124, 2)',
      ...(args.verify !== undefined ? ['$v = $g.verify', ...VERIFY_ASSERTION_PS] : []),
      '$out = @{ result=$res; x=$p.X; y=$p.Y; requested=@{ x=[int]$g.x; y=[int]$g.y }; space=$space; origin=$origin; scale=$wscale; absolute=@{ x=$absX; y=$absY }; insideWindow=$inside; target=$target; fgHandle=[int64]$fgParts[0]; fgTitle=[string]$fgParts[1] }',
      'if ($null -ne $vres) { $out["verify"] = $vres }',
      '$out | ConvertTo-Json -Compress -Depth 5',
    ].join('\n') }
  }, 60000)

  registerGuiTool({
    name: 'gui_drag',
    description: 'Press the mouse at (fromX,fromY), move to (toX,toY) while holding, then release - a real drag: select text, move or resize a window by its title bar/border, drag a slider or scrollbar, drag-and-drop a file. Movement is interpolated (SetCursorPos alone does not produce drag events for most apps). Coordinates are virtual-desktop physical pixels by default; with space=window-local they are window-local image pixels as seen in gui_window_shot, converted in-process. `window` names the target explicitly. Takes over the user mouse briefly. The button is released even if movement fails. The receipt reports space/origin/scale/requested/absolute (both points) and insideWindow, which is true only when BOTH endpoints fall inside the window rect. Result echoes the focused window.',
    parameters: {
      fromX: { type: 'number', required: true, description: 'Press point X (virtual-desktop physical px, or window-local px when space=window-local)' },
      fromY: { type: 'number', required: true, description: 'Press point Y' },
      toX: { type: 'number', required: true, description: 'Release point X' },
      toY: { type: 'number', required: true, description: 'Release point Y' },
      button: { type: 'string', description: 'left (default) | right | middle' },
      steps: { type: 'number', description: 'Interpolated move steps (default 16, max 120). Raise for apps that only accept slow drags' },
      stepDelayMs: { type: 'number', description: 'Delay per step in ms (default 16, max 250)' },
      window: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Per-call target: window title substring, or a handle from gui_window. Required when space=window-local; when given it is also used for the insideWindow check.' },
      space: { type: 'string', description: 'virtual-desktop (default) | window-local (all four coordinates are gui_window_shot image pixels).' },
    },
  }, (args) => {
    for (const k of ['fromX', 'fromY', 'toX', 'toY']) {
      if (typeof args[k] !== 'number') throw new Error('gui_drag needs numeric ' + k)
    }
    const space = args.space === undefined ? 'virtual-desktop' : String(args.space)
    if (space !== 'virtual-desktop' && space !== 'window-local') throw new Error('gui_drag space must be virtual-desktop|window-local')
    if (space === 'window-local' && (args.window === undefined || args.window === null)) throw new Error('gui_drag space=window-local needs window (title substring or handle)')
    const payload = { fromX: args.fromX, fromY: args.fromY, toX: args.toX, toY: args.toY, button: args.button || 'left', steps: args.steps || 16, stepDelayMs: args.stepDelayMs || 16, space: space }
    if (args.window !== undefined && args.window !== null) payload.window = args.window
    return { json: JSON.stringify(payload), body: [
      ...WINDOW_TARGET_PS,
      'if ($space -eq "window-local") {',
      '  $fX = [int]($r.Left + [Math]::Round([double]$g.fromX * $wscale, 0)); $fY = [int]($r.Top + [Math]::Round([double]$g.fromY * $wscale, 0))',
      '  $tX = [int]($r.Left + [Math]::Round([double]$g.toX * $wscale, 0)); $tY = [int]($r.Top + [Math]::Round([double]$g.toY * $wscale, 0))',
      '} else { $fX = [int]$g.fromX; $fY = [int]$g.fromY; $tX = [int]$g.toX; $tY = [int]$g.toY }',
      // 两端都在窗口物理 rect 内才算 insideWindow（拖拽的起点与终点都可能落到窗口外）。
      'if ($hwnd -ne [IntPtr]::Zero) {',
      '  $inF = (($fX -ge $r.Left) -and ($fX -lt $r.Right) -and ($fY -ge $r.Top) -and ($fY -lt $r.Bottom))',
      '  $inT = (($tX -ge $r.Left) -and ($tX -lt $r.Right) -and ($tY -ge $r.Top) -and ($tY -lt $r.Bottom))',
      '  $inside = ($inF -and $inT)',
      '}',
      '$res = [U32]::Drag($fX, $fY, $tX, $tY, [string]$g.button, [int]$g.steps, [int]$g.stepDelayMs)',
      'Start-Sleep -Milliseconds 150',
      '$p = New-Object POINT',
      '[void][U32]::GetCursorPos([ref]$p)',
      '$fgParts = ([U32]::FgTitle()).Split([char]124, 2)',
      '@{ result=$res; x=$p.X; y=$p.Y; requested=@{ from=@{ x=[int]$g.fromX; y=[int]$g.fromY }; to=@{ x=[int]$g.toX; y=[int]$g.toY } }; absolute=@{ from=@{ x=$fX; y=$fY }; to=@{ x=$tX; y=$tY } }; space=$space; origin=$origin; scale=$wscale; insideWindow=$inside; target=$target; fgHandle=[int64]$fgParts[0]; fgTitle=[string]$fgParts[1] } | ConvertTo-Json -Compress -Depth 5',
    ].join('\n') }
  }, 30000)

  registerGuiTool({
    name: 'gui_type',
    description: 'Type text into the currently FOCUSED control. Unicode mode (default) injects every character incl. Chinese via SendInput bypassing the IME; clipboard mode overwrites the user clipboard and pastes with Ctrl+V. Optionally click (x,y) first to move focus there. Windows foreground rule: typing lands on whatever has focus - activate/click the target first. Result echoes focused window.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to type' },
      mode: { type: 'string', description: 'unicode (default) | clipboard' },
      x: { type: 'number', description: 'Optional click-first X' },
      y: { type: 'number', description: 'Optional click-first Y' },
    },
  }, (args) => {
    if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('gui_type needs non-empty text')
    const payload = { text: args.text, mode: args.mode === 'clipboard' ? 'clipboard' : 'unicode', x: (typeof args.x === 'number' ? args.x : null), y: (typeof args.y === 'number' ? args.y : null) }
    return { json: JSON.stringify(payload), body: [
      'if ($null -ne $g.x -and $null -ne $g.y) {',
      '  [void][U32]::Click([int]$g.x, [int]$g.y, "left", 1)',
      '  Start-Sleep -Milliseconds 300',
      '}',
      '$mode = [string]$g.mode',
      'if ($mode -eq "clipboard") {',
      '  Set-Clipboard -Value ([string]$g.text)',
      '  Start-Sleep -Milliseconds 200',
      '  $res = [U32]::TapKeys([ushort[]]@(0x11, 0x56))',
      '} else {',
      '  $res = [U32]::TypeText([string]$g.text)',
      '}',
      '$fgParts = ([U32]::FgTitle()).Split([char]124, 2)',
      '@{ result=$res; mode=$mode; fgHandle=[int64]$fgParts[0]; fgTitle=$fgParts[1] } | ConvertTo-Json -Compress',
    ].join('\n') }
  }, 20000)

  registerGuiTool({
    name: 'gui_key',
    description: 'Press a key or chord on the REAL keyboard, e.g. "enter", "ctrl+s", "alt+f4", "ctrl+shift+tab", "win", "printscreen". Lands on the focused window. Supported: modifiers ctrl/alt/shift/win, f1-f24, a-z, 0-9, enter/tab/esc/space/backspace/delete/insert/home/end/pgup/pgdn/arrows/printscreen.',
    parameters: {
      keys: { type: 'string', required: true, description: 'Key chord like ctrl+s or enter' },
    },
  }, (args) => {
    const vks = parseKeySpec(args.keys)
    return { json: JSON.stringify({ vks: vks }), body: [
      '$res = [U32]::TapKeys([ushort[]]$g.vks)',
      'Start-Sleep -Milliseconds 100',
      '@{ result=$res } | ConvertTo-Json -Compress',
    ].join('\n') }
  }, 12000)

  registerGuiTool({
    name: 'gui_scroll',
    description: 'Scroll the mouse wheel at (x,y): moves the cursor there then sends wheel notches. direction up/down = vertical wheel, left/right = horizontal wheel. notches default 3.',
    parameters: {
      x: { type: 'number', required: true, description: 'Cursor X before scrolling' },
      y: { type: 'number', required: true, description: 'Cursor Y before scrolling' },
      direction: { type: 'string', description: 'up (default) | down | left | right' },
      notches: { type: 'number', description: 'Detents to scroll (default 3)' },
    },
  }, (args) => {
    if (typeof args.x !== 'number' || typeof args.y !== 'number') throw new Error('gui_scroll needs numeric x and y')
    const dir = ['up', 'down', 'left', 'right'].indexOf(String(args.direction)) >= 0 ? String(args.direction) : 'up'
    const notches = Math.max(1, Math.min(20, args.notches || 3))
    return { json: JSON.stringify({ x: args.x, y: args.y, direction: dir, notches: notches }), body: [
      '$res = [U32]::ScrollAt([int]$g.x, [int]$g.y, [int]$g.notches, [string]$g.direction)',
      '@{ result=$res } | ConvertTo-Json -Compress',
    ].join('\n') }
  }, 15000)

  registerGuiTool({
    name: 'gui_window',
    description: 'Inspect or drive top-level windows. action=list (visible windows with title/handle/pid/process/rect, z-order), action=rect (one window bounds by handle), action=activate (bring to foreground by handle - may fail if the user is actively using another window), action=move (set bounds by handle with x,y,w,h).',
    parameters: {
      action: { type: 'string', required: true, description: 'list | rect | activate | move' },
      handle: { type: 'number', description: 'Window handle (from list) for rect/activate/move' },
      title: { type: 'string', description: 'Optional substring filter for list' },
      x: { type: 'number', description: 'move: left' },
      y: { type: 'number', description: 'move: top' },
      w: { type: 'number', description: 'move: width' },
      h: { type: 'number', description: 'move: height' },
      limit: { type: 'number', description: 'list: max entries (default 40)' },
    },
  }, (args) => {
    const action = String(args.action || '')
    if (['list', 'rect', 'activate', 'move'].indexOf(action) < 0) throw new Error('gui_window action must be list|rect|activate|move')
    if (action !== 'list' && typeof args.handle !== 'number') throw new Error('gui_window ' + action + ' needs numeric handle')
    return { json: JSON.stringify(args), body: [
      '$action = [string]$g.action',
      'if ($action -eq "list") {',
      '  $wins = New-Object System.Collections.ArrayList',
      '  $cb = [EnumProc]{ param($h, $l)',
      '    if ([U32]::IsWindowVisible($h)) {',
      '      $sb = New-Object System.Text.StringBuilder 512',
      '      [void][U32]::GetWindowText($h, $sb, 512)',
      '      $t = $sb.ToString()',
      '      if ($t.Length -gt 0) {',
      '        $procId = [uint32]0',
      '        [void][U32]::GetWindowThreadProcessId($h, [ref]$procId)',
      '        $r = New-Object RECT',
      '        [void][U32]::GetWindowRect($h, [ref]$r)',
      '        $pn = ""',
      '        try { $pn = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}',
      '        [void]$wins.Add(@{ handle=$h.ToInt64(); title=$t; pid=$procId; process=$pn; x=$r.Left; y=$r.Top; w=($r.Right - $r.Left); h=($r.Bottom - $r.Top) })',
      '      }',
      '    }',
      '    return $true',
      '  }',
      '  [void][U32]::EnumWindows($cb, [IntPtr]::Zero)',
      '  $limit = 40; if ($g.limit) { $limit = [int]$g.limit }',
      '  $out = @($wins | Select-Object -First $limit)',
      '  if ($g.title) { $out = @($out | Where-Object { $_.title -like ("*" + $g.title + "*") }) }',
      '  @{ windows=$out } | ConvertTo-Json -Compress -Depth 4',
      '} elseif ($action -eq "activate") {',
      '  $res = [U32]::Activate([IntPtr][int64]$g.handle)',
      '  @{ result=$res } | ConvertTo-Json -Compress',
      '} elseif ($action -eq "move") {',
      '  $ok = [U32]::SetWindowPos([IntPtr][int64]$g.handle, [IntPtr]::Zero, [int]$g.x, [int]$g.y, [int]$g.w, [int]$g.h, 0x0040)',
      '  @{ ok=[bool]$ok } | ConvertTo-Json -Compress',
      '} elseif ($action -eq "rect") {',
      '  $r = New-Object RECT',
      '  [void][U32]::GetWindowRect([IntPtr][int64]$g.handle, [ref]$r)',
      '  @{ x=$r.Left; y=$r.Top; w=($r.Right - $r.Left); h=($r.Bottom - $r.Top) } | ConvertTo-Json -Compress',
      '}',
    ].join('\n') }
  }, 15000)

  registerGuiTool({
    name: 'gui_wait',
    description: 'Poll until a condition or timeout. mode=pixel watches screen pixel (x,y): compare=change (default) fires when color differs from the baseline captured at call start; eq/neq compare against given r,g,b. mode=window fires when a top-level window whose title contains `title` exists. Use after clicks to verify effects before screenshotting again.',
    parameters: {
      mode: { type: 'string', required: true, description: 'pixel | window' },
      title: { type: 'string', description: 'window mode: title substring' },
      x: { type: 'number', description: 'pixel mode: X' },
      y: { type: 'number', description: 'pixel mode: Y' },
      compare: { type: 'string', description: 'change (default) | eq | neq' },
      r: { type: 'number', description: 'eq/neq: red 0-255' },
      g: { type: 'number', description: 'eq/neq: green' },
      b: { type: 'number', description: 'eq/neq: blue' },
      timeoutMs: { type: 'number', description: 'Default 10000, cap 55000' },
      intervalMs: { type: 'number', description: 'Default 250' },
    },
  }, (args) => {
    const mode = String(args.mode || '')
    if (mode !== 'pixel' && mode !== 'window') throw new Error('gui_wait mode must be pixel|window')
    if (mode === 'window' && !args.title) throw new Error('gui_wait window mode needs title')
    if (mode === 'pixel' && (typeof args.x !== 'number' || typeof args.y !== 'number')) throw new Error('gui_wait pixel mode needs x,y')
    return { json: JSON.stringify(args), body: [
      '$timeout = 10000; if ($g.timeoutMs) { $timeout = [int]$g.timeoutMs }; if ($timeout -gt 55000) { $timeout = 55000 }',
      '$interval = 250; if ($g.intervalMs) { $interval = [Math]::Max(80, [int]$g.intervalMs) }',
      '$sw = [System.Diagnostics.Stopwatch]::StartNew()',
      '$met = $false; $detail = "timeout"',
      'if ($g.mode -eq "window") {',
      '  $needle = "*" + $g.title + "*"',
      '  while ($sw.ElapsedMilliseconds -lt $timeout) {',
      '    $script:hit = $false',
      '    $cb = [EnumProc]{ param($h, $l)',
      '      if ([U32]::IsWindowVisible($h)) {',
      '        $sb = New-Object System.Text.StringBuilder 512',
      '        [void][U32]::GetWindowText($h, $sb, 512)',
      '        if ($sb.ToString() -like $needle) { $script:hit = $true; return $false }',
      '      }',
      '      return $true',
      '    }',
      '    [void][U32]::EnumWindows($cb, [IntPtr]::Zero)',
      '    if ($script:hit) { $met = $true; $detail = "window found"; break }',
      '    Start-Sleep -Milliseconds $interval',
      '  }',
      '} else {',
      '  $wbmp = New-Object System.Drawing.Bitmap 1, 1',
      '  function Get-Px([int]$px, [int]$py) {',
      '    $wg = [System.Drawing.Graphics]::FromImage($wbmp)',
      '    $wg.CopyFromScreen($px, $py, 0, 0, (New-Object System.Drawing.Size(1, 1)))',
      '    $wg.Dispose()',
      '    return $wbmp.GetPixel(0, 0)',
      '  }',
      '  $base = Get-Px ([int]$g.x) ([int]$g.y)',
      '  $cmp = "change"; if ($g.compare) { $cmp = [string]$g.compare }',
      '  while ($sw.ElapsedMilliseconds -lt $timeout) {',
      '    $cur = Get-Px ([int]$g.x) ([int]$g.y)',
      '    $fire = $false',
      '    if ($cmp -eq "eq") { $fire = ($cur.R -eq [int]$g.r -and $cur.G -eq [int]$g.g -and $cur.B -eq [int]$g.b) }',
      '    elseif ($cmp -eq "neq") { $fire = ($cur.R -ne [int]$g.r -or $cur.G -ne [int]$g.g -or $cur.B -ne [int]$g.b) }',
      '    else { $fire = ($cur.R -ne $base.R -or $cur.G -ne $base.G -or $cur.B -ne $base.B) }',
      '    if ($fire) { $met = $true; $detail = "pixel changed"; break }',
      '    Start-Sleep -Milliseconds $interval',
      '  }',
      '  $wbmp.Dispose()',
      '  @{ met=$met; elapsedMs=$sw.ElapsedMilliseconds; detail=$detail; baseline=@{ r=$base.R; g=$base.G; b=$base.B } } | ConvertTo-Json -Compress -Depth 3; exit',
      '}',
      '@{ met=$met; elapsedMs=$sw.ElapsedMilliseconds; detail=$detail } | ConvertTo-Json -Compress',
    ].join('\n') }
  }, 60000)

  registerGuiTool({
    name: 'gui_verify',
    description: 'Verify ONE predicate against the live desktop, with sampling: satisfied only after `stableSamples` consecutive checks agree, otherwise it polls until timeout. mode=element asserts a UIA element exists (optionally also enabled / valueEquals); mode=window asserts a window whose title contains `title` exists (optionally also its bounds). Returns verdict satisfied|unsatisfied|unknown plus what was observed. unknown means it could not be decided (target window absent, tree not enumerable) - never read unknown as success. Absence is not provable, so exists:false is rejected. Use this after gui_click / gui_type / gui_key to confirm the effect actually happened instead of assuming it did.',
    parameters: {
      mode: { type: 'string', required: true, description: 'element | window' },
      title: { type: 'string', description: 'Window title substring. In window mode it is the subject; in element mode it picks which window to search.' },
      handle: { type: 'number', description: 'Or target window handle (element mode; from gui_window list)' },
      name: { type: 'string', description: 'element mode: element Name substring' },
      elType: { type: 'string', description: 'element mode: control type substring like Button/Edit/ListItem' },
      enabled: { type: 'boolean', description: 'element mode: also require IsEnabled=true' },
      valueEquals: { type: 'string', description: 'element mode: also require the ValuePattern text to equal this exactly' },
      exists: { type: 'boolean', description: 'Must be true or omitted. Asserting absence is rejected because absence cannot be proven.' },
      boundsX: { type: 'number', description: 'window mode: expected X (physical px)' },
      boundsY: { type: 'number', description: 'window mode: expected Y' },
      boundsW: { type: 'number', description: 'window mode: expected width' },
      boundsH: { type: 'number', description: 'window mode: expected height' },
      tolerancePx: { type: 'number', description: 'window mode: allowed bounds drift (default 8)' },
      timeoutMs: { type: 'number', description: 'Default 5000, cap 55000' },
      stableSamples: { type: 'number', description: 'Consecutive agreeing checks required (default 2, 1-5)' },
      intervalMs: { type: 'number', description: 'Poll interval (default 250, min 80)' },
    },
  }, (args) => {
    const mode = String(args.mode || '')
    if (mode !== 'element' && mode !== 'window') throw new Error('gui_verify mode must be element|window')
    if (args.exists === false) throw new Error('gui_verify cannot assert absence: absence is not provable. Assert what should be present instead.')
    if (mode === 'element' && !args.name && !args.elType) throw new Error('gui_verify element mode needs name or elType')
    if (mode === 'window' && !args.title && typeof args.handle !== 'number') throw new Error('gui_verify window mode needs title (or handle)')
    const b = ['boundsX', 'boundsY', 'boundsW', 'boundsH'].filter((k) => typeof args[k] === 'number')
    if (b.length !== 0 && b.length !== 4) throw new Error('gui_verify bounds needs all of boundsX/boundsY/boundsW/boundsH')
    return { json: JSON.stringify(args), body: [
      // 断言实现与 gui_click 的 verify 参数共用 VERIFY_ASSERTION_PS（模块级常量），
      // 这里只负责把参数对象交给它（$v = $g）、再把三态结果回带。
      '$v = $g',
      ...VERIFY_ASSERTION_PS,
      '$vres | ConvertTo-Json -Compress -Depth 4',
    ].join('\n') }
  }, 60000)

  registerGuiTool({
    name: 'gui_uia',
    description: 'Windows UI Automation structured query on ONE window - the precision path for standard controls. Target by handle (from gui_window) or title substring, else the foreground window. action=tree lists elements (name/type/rect/enabled); action=find locates elements whose Name contains `name` and/or whose control type matches `elType`; action=invoke presses the first match via InvokePattern (fallback TogglePattern), no coordinates needed; action=value reads an edit/document element text via ValuePattern - verify typed content without screenshots. Rects are physical pixels usable with gui_click directly. status: found | empty-but-accessible (walk finished, tree has content, nothing matched) | not-exposed (nodes exist but none is text/interactive - the app exposes no usable a11y; switch to the visual path: gui_screenshot annotate=true + gui_locate) | inconclusive (the tree has zero nodes - blank window or hidden a11y; do NOT read this as absence) | truncated (the walk stopped early, so absence is NOT proven). Of the counts, total = elements visited, matched = matches found, count = rows actually returned; rows_truncated=true means more matches exist than were returned.',
    parameters: {
      action: { type: 'string', required: true, description: 'tree | find | invoke | value' },
      handle: { type: 'number', description: 'Target window handle (from gui_window list)' },
      title: { type: 'string', description: 'Or target window by title substring' },
      name: { type: 'string', description: 'Element Name substring' },
      elType: { type: 'string', description: 'Control type substring like Edit/Button/ListItem' },
      depth: { type: 'number', description: 'Tree depth limit (default 40, cap 40). The RawView tree of a large app is ~22 levels deep; a lower depth cuts the walk short and makes status "truncated". Raising it walks more elements (slower).' },
      max: { type: 'number', description: 'TRAVERSAL budget: max elements visited (default 2000, cap 8000). Separate from maxRows, which only caps the returned rows. Raise it when truncated=true and you need certainty.' },
      maxRows: { type: 'number', description: 'RETURN budget: max rows in `elements` (default 120, cap 2000). Does not change the walk or the counts; when matched > count the result carries rows_truncated=true - then narrow name/elType, or raise this explicitly.' },
    },
  }, (args) => {
    const action = String(args.action || '')
    if (['tree', 'find', 'invoke', 'value'].indexOf(action) < 0) throw new Error('gui_uia action must be tree|find|invoke|value')
    if (action !== 'tree' && !args.name && !args.elType) throw new Error('gui_uia ' + action + ' needs name or elType')
    return { json: JSON.stringify(args), body: [
      'Add-Type -AssemblyName UIAutomationClient',
      'Add-Type -AssemblyName UIAutomationTypes',
      '$target = $null',
      'if ($null -ne $g.handle) {',
      // 句柄失效/窗口已关时 FromHandle 抛「无法识别的错误」；不接住的话上层只看到裸的
      // 「pwsh exit=1 no JSON」，失败原因不可读（verify 连续复现过 3 次）。
      '  try { $target = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$g.handle) } catch { $target = $null }',
      '  if ($null -eq $target) { @{ error=("window handle " + [int64]$g.handle + " is no longer valid (the window may have closed)") } | ConvertTo-Json -Compress; exit }',
      '} elseif ($g.title) {',
      '  $wcond = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Window)',
      '  $wins = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $wcond)',
      '  foreach ($w in $wins) { try { if ($w.Current.Name -like ("*" + $g.title + "*")) { $target = $w; break } } catch {} }',
      '} else {',
      '  try { $target = [System.Windows.Automation.AutomationElement]::FromForeground() } catch { $target = $null }',
      '}',
      'if ($null -eq $target) { @{ error="target window not found" } | ConvertTo-Json -Compress; exit }',
      // RawView 里 IsControlElement=false 的中间层把真实内容推深：同一 depth 预算在两种 walker 之间
      // 覆盖的内容量并不等价（ControlView 是塌缩视图，同 depth 反而更多）。实测同一 DSH 窗口：
      // Control@10=46 / Raw@10=14 / Raw@20=752 / Raw@40=935~970，真实深度 22~23 —— 只换 walker
      // 不提 depth 会比升级前更差，所以 depth 默认必须一起提到 40。
      '$maxDepth = 40; if ($g.depth) { $maxDepth = [Math]::Min(40, [Math]::Max(1, [int]$g.depth)) }',
      '$maxN = 2000; if ($g.max) { $maxN = [Math]::Min(8000, [Math]::Max(1, [int]$g.max)) }',
      '$maxRows = 120; if ($g.maxRows) { $maxRows = [Math]::Min(2000, [Math]::Max(1, [int]$g.maxRows)) }',
      '$filter = ""; if ($g.name) { $filter = [string]$g.name }',
      '$typeFilter = ""; if ($g.elType) { $typeFilter = [string]$g.elType }',
      '$action = [string]$g.action',
      '$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker',
      "$interactiveTypes = @('Button','Edit','CheckBox','RadioButton','ComboBox','ListItem','TreeItem','DataItem','Menu','MenuItem','Hyperlink','Tab','TabItem','ScrollBar','Slider','Spinner','Thumb','SplitButton')",
      'function Reset-Walk {',
      '  $script:visited = 0; $script:rows = New-Object System.Collections.ArrayList',
      '  $script:firstEl = $null; $script:depthReached = 0; $script:depthCut = 0',
      '  $script:budgetHit = $false; $script:textCount = 0; $script:interactiveCount = 0',
      '}',
      'function Visit-El($el, $depth) {',
      '  if ($script:budgetHit) { return }',
      '  try { $child = $walker.GetFirstChild($el) } catch { return }',
      '  while ($null -ne $child) {',
      '    if ($script:visited -ge $maxN) { $script:budgetHit = $true; return }',
      '    $script:visited = $script:visited + 1',
      '    $cd = $depth + 1',
      '    if ($cd -gt $script:depthReached) { $script:depthReached = $cd }',
      '    $descend = ($cd -lt $maxDepth)',
      '    try {',
      '      $c = $child.Current',
      '      $r = $c.BoundingRectangle',
      '      $nm = [string]$c.Name',
      '      $tn = [string]$c.ControlType.ProgrammaticName',
      '      $tn = $tn.Replace("ControlType.", "")',
      '      if ($tn -eq "Text") { $script:textCount = $script:textCount + 1 }',
      '      if ($interactiveTypes -contains $tn) { $script:interactiveCount = $script:interactiveCount + 1 }',
      '      $nameOk = ($filter -eq "") -or ($nm -like ("*" + $filter + "*"))',
      '      $typeOk = ($typeFilter -eq "") -or ($tn -like ("*" + $typeFilter + "*"))',
      '      if ($nameOk -and $typeOk) {',
      '        [void]$script:rows.Add(@{ name=$nm; type=$tn; x=[int]$r.X; y=[int]$r.Y; w=[int]$r.Width; h=[int]$r.Height; enabled=$c.IsEnabled; offscreen=$c.IsOffscreen })',
      '        if ($action -ne "tree" -and $null -eq $script:firstEl) { $script:firstEl = $child }',
      '      }',
      '    } catch {}',
      // 到了 depth 上限就不再往下走，但「这一层还有子节点」要记账 —— 有四态里的 truncated
      // 靠它判定，否则「没匹配」会被误报成「确实不存在」。
      '    if ($descend) { Visit-El $child $cd } else { try { if ($null -ne $walker.GetFirstChild($child)) { $script:depthCut = $script:depthCut + 1 } } catch {} }',
      '    $child = $walker.GetNextSibling($child)',
      '  }',
      '}',
      // 五态。基石是「遍历自然走完」：没走完就只能说 truncated，不许对「不存在」下结论。
      // 自然走完后再按树的形状分：有文本/可交互节点 → 正常；有节点但零内容 → not-exposed（有渲染面）；
      // 一个节点都没有 → inconclusive（空白窗口与「a11y 被藏」分不清，Qt/自绘类会长这样）。
      // 分流看 total（遍历到的节点数）而不是 matched（匹配行数）：空壳窗口上 find 的匹配数恒为 0，
      // 按 matched 分流会让 not-exposed 在 find/invoke/value 上永不可达，同一个 total=4 的窗口
      // 只因 action 不同就给出两个结论。
      // 注意 PS 变量名大小写不敏感：interactiveTypes / interactiveCount / textCount 三个名字必须彼此不撞，
      // 否则计数会被静默覆盖成 0，判据退化（探针上踩过一次）。
      'function Get-WalkStatus {',
      '  $natural = ((-not $script:budgetHit) -and ($script:depthCut -eq 0))',
      '  $shell = (($script:textCount -eq 0) -and ($script:interactiveCount -eq 0))',
      '  if ($script:rows.Count -gt 0 -and $action -ne "tree") { return "found" }',
      '  if ($natural -and $shell) { if ($script:visited -gt 0) { return "not-exposed" } else { return "inconclusive" } }',
      '  if ($script:rows.Count -gt 0) { return "found" }',
      '  if (-not $natural) { return "truncated" }',
      '  return "empty-but-accessible"',
      '}',
      'Reset-Walk',
      'Visit-El $target 0',
      '$status = Get-WalkStatus',
      '# not-exposed 最多重试 1 次，且落在同一个 pwsh 进程内（实测 4 分钟内读数一动不动，多试无益）。',
      'if ($status -eq "not-exposed") { Start-Sleep -Milliseconds 400; Reset-Walk; Visit-El $target 0; $status = Get-WalkStatus }',
      '$natural = ((-not $script:budgetHit) -and ($script:depthCut -eq 0))',
      '$truncated = -not $natural',
      '$visible = @($script:rows | Select-Object -First $maxRows)',
      '$rowsTruncated = ($script:rows.Count -gt $visible.Count)',
      '$hints = @()',
      'if ($status -eq "not-exposed") { $hints += "the tree has nodes but zero text/interactive ones: this app exposes no usable a11y tree - switch to the visual path (gui_screenshot annotate=true, then gui_locate / gui_click)." }',
      'if ($status -eq "inconclusive") { $hints += "the tree is empty (0 nodes): either a blank window, or an app whose a11y tree is hidden (Qt / custom-drawn). Retrying will not help - if you expect content here, use the visual path (gui_screenshot annotate=true, then gui_locate)." }',
      'if ($truncated -and $status -ne "not-exposed") { $hints += ("walk stopped early: depth_reached=" + $script:depthReached + "/" + $maxDepth + ", visited=" + $script:visited + "/" + $maxN + " - raise depth/max or widen name; absence is NOT proven.") }',
      'if ($rowsTruncated) { $hints += ("returned " + $visible.Count + " of " + $script:rows.Count + " matches (maxRows=" + $maxRows + "): narrow name/elType, or raise maxRows - do NOT read this list as complete.") }',
      'if ($action -eq "tree" -or $action -eq "find") {',
      '  $out = @{ window=$target.Current.Name; count=$visible.Count; elements=$visible; matched=$script:rows.Count; total=$script:visited; depth_reached=$script:depthReached; walker="RawView"; status=$status; truncated=[bool]$truncated; rows_truncated=[bool]$rowsTruncated }',
      '  if ($hints.Count -gt 0) { $out["hints"] = $hints; $out["hint"] = $hints[0] }',
      '  $out | ConvertTo-Json -Compress -Depth 4; exit',
      '}',
      'if ($status -eq "not-exposed" -or $status -eq "inconclusive" -or $status -eq "truncated") {',
      '  @{ window=$target.Current.Name; status=$status; action=$action; total=$script:visited; depth_reached=$script:depthReached; hints=$hints; hint=$hints[0] } | ConvertTo-Json -Compress -Depth 4; exit',
      '}',
      'if ($null -eq $script:firstEl) { @{ window=$target.Current.Name; status=$status; error=("no element matching" + $(if ($filter) { " name=" + $filter } else { "" }) + $(if ($typeFilter) { " type=" + $typeFilter } else { "" }) + " (walk finished: total=" + $script:visited + ")"); hint="run action=tree to inspect" } | ConvertTo-Json -Compress; exit }',
      'if ($action -eq "invoke") {',
      '  $pat = $null; $kind = "none"',
      '  try { $pat = $script:firstEl.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $kind = "invoke" } catch {}',
      '  if ($null -eq $pat) { try { $pat = $script:firstEl.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $kind = "toggle" } catch {} }',
      '  if ($null -eq $pat) { @{ error="element has no Invoke/Toggle pattern" } | ConvertTo-Json -Compress; exit }',
      '  if ($kind -eq "toggle") { $pat.Toggle() } else { $pat.Invoke() }',
      '  Start-Sleep -Milliseconds 350',
      '  $fgParts = ([U32]::FgTitle()).Split([char]124, 2)',
      '  @{ invoked=$true; via=$kind; fgHandle=[int64]$fgParts[0]; fgTitle=$fgParts[1] } | ConvertTo-Json -Compress -Depth 3; exit',
      '}',
      'if ($action -eq "value") {',
      '  $val = $null',
      '  try { $val = ($script:firstEl.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value } catch {}',
      '  if ($null -eq $val) { @{ error="element has no ValuePattern" } | ConvertTo-Json -Compress; exit }',
      '  @{ value=$val } | ConvertTo-Json -Compress -Depth 3; exit',
      '}',
    ].join('\n') }
  }, 45000)

  registerGuiTool({
    name: 'gui_locate',
    description: 'Locate ONE element by Name in a window and return a coordinate gui_click can use directly. Target the window with `window` (recommended) or its alias `title` (title substring or handle from gui_window); with neither, the foreground window is used. Never returns a guessed coordinate: point is present only for status=found. status: found (exactly one match, or index given) | ambiguous (several matches and no index - candidates[] lists the first 5 with their rects/points/offscreen) | offscreen (the match is off-screen or its centre falls outside the window rect - make it visible first, do NOT click that coordinate) | not-found (walk finished, nothing matched) | not-exposed / inconclusive (the app exposes no usable a11y tree - use the visual path gui_screenshot annotate=true) | truncated (the walk stopped early, so absence is NOT proven).',
    parameters: {
      name: { type: 'string', required: true, description: 'Element Name substring to locate' },
      window: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Target window (recommended): title substring or handle from gui_window. Defaults to the foreground window.' },
      title: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Alias of window (same meaning; window wins if both are given).' },
      elType: { type: 'string', description: 'Optional control type substring (Button/Edit/Text/...)' },
      index: { type: 'number', description: 'Which match to take (0-based). Omit when you expect a single hit; when several elements match and index is omitted the result is ambiguous with a candidates[] list.' },
      depth: { type: 'number', description: 'Tree depth limit (default 40, cap 40)' },
      max: { type: 'number', description: 'Traversal budget: max elements visited (default 2000, cap 8000). Raise it when truncated=true and you need certainty.' },
      timeoutMs: { type: 'number', description: 'Optional: keep re-walking until an element appears (default 0 = single pass)' },
    },
  }, (args) => {
    if (typeof args.name !== 'string' || args.name.length === 0) throw new Error('gui_locate needs a non-empty name')
    if (args.index !== undefined && (!Number.isInteger(args.index) || args.index < 0)) throw new Error('gui_locate index must be a non-negative integer')
    if (args.elType !== undefined && typeof args.elType !== 'string') throw new Error('gui_locate elType must be a string')
    // window（推荐）与 title（别名，和 gui_uia/gui_verify 的叫法对齐）等价；两者都给时 window 优先。
    const win = (args.window !== undefined && args.window !== null) ? args.window : args.title
    const payload = { name: args.name }
    if (win !== undefined && win !== null) payload.window = win
    for (const k of ['elType', 'index', 'depth', 'max', 'timeoutMs']) {
      if (args[k] !== undefined) payload[k] = args[k]
    }
    return { json: JSON.stringify(payload), body: [
      'Add-Type -AssemblyName UIAutomationClient',
      'Add-Type -AssemblyName UIAutomationTypes',
      ...WINDOW_TARGET_PS,
      // WINDOW_TARGET_PS 只在给了 window 时填 $r/$origin/$target（$target 是**描述符哈希表**，不是元素！）；
      // 没给就用前台窗口兜底。真正要遍历的根元素是 $lroot —— 早期版本误把 $target 当元素传给 Visit-L，
      // 结果一次都没往下走（total=0 → 假 inconclusive），所以这里显式分开命名。
      '$lroot = $null',
      'if ($null -ne $g.window) {',
      '  try { $lroot = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) } catch { $lroot = $null }',
      '  if ($null -eq $lroot) { @{ error=("window handle " + $hwnd.ToInt64() + " is no longer valid (the window may have closed)") } | ConvertTo-Json -Compress; exit }',
      '} else {',
      '  try { $lroot = [System.Windows.Automation.AutomationElement]::FromForeground() } catch { $lroot = $null }',
      '  if ($null -eq $lroot) { @{ error="no foreground window available (the desktop may be locked, or nothing has focus); pass window explicitly" } | ConvertTo-Json -Compress; exit }',
      '  try { $hwnd = [IntPtr][int64]$lroot.Current.NativeWindowHandle } catch { $hwnd = [IntPtr]::Zero }',
      '  if ($hwnd -eq [IntPtr]::Zero -or -not [U32]::IsWindow($hwnd)) { @{ error="the foreground element has no top-level window handle; pass window explicitly" } | ConvertTo-Json -Compress; exit }',
      '  $r = New-Object RECT; [void][U32]::GetWindowRect($hwnd, [ref]$r)',
      '  if (($r.Right - $r.Left) -lt 1 -or ($r.Bottom - $r.Top) -lt 1) { @{ error=("window " + $hwnd.ToInt64() + " has no usable rect (it may be closing)") } | ConvertTo-Json -Compress; exit }',
      '  $origin = @{ x=$r.Left; y=$r.Top }',
      '  $target = @{ handle=$hwnd.ToInt64(); title=[string]$lroot.Current.Name }',
      '}',
      '$maxDepth = 40; if ($g.depth) { $maxDepth = [Math]::Min(40, [Math]::Max(1, [int]$g.depth)) }',
      '$maxN = 2000; if ($g.max) { $maxN = [Math]::Min(8000, [Math]::Max(1, [int]$g.max)) }',
      '$lwait = 0; if ($g.timeoutMs) { $lwait = [Math]::Max(0, [int]$g.timeoutMs) }',
      '$lname = [string]$g.name',
      '$ltype = ""; if ($g.elType) { $ltype = [string]$g.elType }',
      "$interactiveTypes = @('Button','Edit','CheckBox','RadioButton','ComboBox','ListItem','TreeItem','DataItem','Menu','MenuItem','Hyperlink','Tab','TabItem','ScrollBar','Slider','Spinner','Thumb','SplitButton')",
      '$lwalker = [System.Windows.Automation.TreeWalker]::RawViewWalker',
      'function Reset-LWalk {',
      '  $script:lvisited = 0; $script:lhits = New-Object System.Collections.ArrayList; $script:lels = New-Object System.Collections.ArrayList',
      '  $script:ldepthReached = 0; $script:ldepthCut = 0; $script:lbudgetHit = $false',
      '  $script:ltextCount = 0; $script:linteractiveCount = 0',
      '}',
      'function Visit-L($el, $depth) {',
      '  if ($script:lbudgetHit) { return }',
      '  try { $child = $lwalker.GetFirstChild($el) } catch { return }',
      '  while ($null -ne $child) {',
      '    if ($script:lvisited -ge $maxN) { $script:lbudgetHit = $true; return }',
      '    $script:lvisited = $script:lvisited + 1',
      '    $cd = $depth + 1',
      '    if ($cd -gt $script:ldepthReached) { $script:ldepthReached = $cd }',
      '    $descend = ($cd -lt $maxDepth)',
      '    try {',
      '      $lc = $child.Current',
      '      $lrect = $lc.BoundingRectangle',
      '      $lnm = [string]$lc.Name',
      '      $ltn = [string]$lc.ControlType.ProgrammaticName',
      '      $ltn = $ltn.Replace("ControlType.", "")',
      '      if ($ltn -eq "Text") { $script:ltextCount = $script:ltextCount + 1 }',
      '      if ($interactiveTypes -contains $ltn) { $script:linteractiveCount = $script:linteractiveCount + 1 }',
      '      $lw = [int]$lrect.Width; $lh = [int]$lrect.Height',
      // 空矩形（0x0 / -1）不是可点的目标，不算命中。
      '      if (($lnm -like ("*" + $lname + "*")) -and (($ltype -eq "") -or ($ltn -like ("*" + $ltype + "*"))) -and $lw -gt 0 -and $lh -gt 0) {',
      '        [void]$script:lhits.Add(@{ name=$lnm; type=$ltn; x=[int]$lrect.X; y=[int]$lrect.Y; w=$lw; h=$lh; enabled=$lc.IsEnabled; offscreen=$lc.IsOffscreen; cx=[int]($lrect.X + ($lrect.Width / 2)); cy=[int]($lrect.Y + ($lrect.Height / 2)) })',
      '        [void]$script:lels.Add($child)',
      '      }',
      '    } catch {}',
      '    if ($descend) { Visit-L $child $cd } else { try { if ($null -ne $lwalker.GetFirstChild($child)) { $script:ldepthCut = $script:ldepthCut + 1 } } catch {} }',
      '    $child = $lwalker.GetNextSibling($child)',
      '  }',
      '}',
      // 与 gui_uia 同源：自然走完 + textCount/interactiveCount/total 三口径。
      'function Get-LStatus {',
      '  $lnatural = ((-not $script:lbudgetHit) -and ($script:ldepthCut -eq 0))',
      '  $lshell = (($script:ltextCount -eq 0) -and ($script:linteractiveCount -eq 0))',
      '  if ($script:lhits.Count -gt 0) { return "found" }',
      '  if ($lnatural -and $lshell) { if ($script:lvisited -gt 0) { return "not-exposed" } else { return "inconclusive" } }',
      '  if (-not $lnatural) { return "truncated" }',
      '  return "not-found"',
      '}',
      '$lsw = [System.Diagnostics.Stopwatch]::StartNew()',
      '$lattempt = 0',
      'while ($true) {',
      '  $lattempt = $lattempt + 1',
      '  Reset-LWalk',
      '  Visit-L $lroot 0',
      '  $lstatus = Get-LStatus',
      '  if ($lstatus -eq "not-exposed" -and $lattempt -eq 1) { Start-Sleep -Milliseconds 400; continue }',
      '  if ($lstatus -eq "not-found" -and $lwait -gt 0 -and $lsw.ElapsedMilliseconds -lt $lwait) { Start-Sleep -Milliseconds 250; continue }',
      '  break',
      '}',
      '$lnatural = ((-not $script:lbudgetHit) -and ($script:ldepthCut -eq 0))',
      '$ltruncated = -not $lnatural',
      '$lsel = $null; $lselEl = $null; $lindex = $null; $lstatusFinal = $lstatus',
      // 命中分流：给了 index 就用它；>1 且没给 index → ambiguous（列候选，不给顶层 point）；越界 → 明确报错。
      'if ($script:lhits.Count -gt 0) {',
      '  if ($null -eq $g.index -and $script:lhits.Count -gt 1) { $lstatusFinal = "ambiguous" }',
      '  else {',
      '    $li = 0; if ($null -ne $g.index) { $li = [int]$g.index }',
      '    if ($li -lt 0 -or $li -ge $script:lhits.Count) {',
      '      @{ error=("index " + $li + " out of range: matched=" + $script:lhits.Count + " (valid index 0.." + ($script:lhits.Count - 1) + ")"); status="not-found"; window=$target.title; matched=$script:lhits.Count; validIndex="0.." + ($script:lhits.Count - 1) } | ConvertTo-Json -Compress -Depth 4; exit',
      '    }',
      '    $lsel = $script:lhits[$li]; $lselEl = $script:lels[$li]; $lindex = $li; $lstatusFinal = "found"',
      '  }',
      '}',
      // offscreen：元素自己说离屏，或矩形中心落在目标窗口物理 rect 之外 —— 都不给 point。
      'if ($lstatusFinal -eq "found") {',
      '  $lcx = [int]$lsel["cx"]; $lcy = [int]$lsel["cy"]',
      '  $lwinOk = (($lcx -ge $r.Left) -and ($lcx -lt $r.Right) -and ($lcy -ge $r.Top) -and ($lcy -lt $r.Bottom))',
      '  if ($lsel["offscreen"] -eq $true -or -not $lwinOk) { $lstatusFinal = "offscreen" }',
      '}',
      '$lhints = @()',
      'if ($lstatusFinal -eq "not-exposed") { $lhints += "the tree has nodes but zero text/interactive ones: this app exposes no usable a11y tree - use the visual path (gui_screenshot annotate=true)." }',
      'if ($lstatusFinal -eq "inconclusive") { $lhints += "the tree is empty (0 nodes): either a blank window or hidden a11y - if you expect content here, use the visual path." }',
      'if ($lstatusFinal -eq "truncated") { $lhints += ("walk stopped early: depth_reached=" + $script:ldepthReached + "/" + $maxDepth + ", visited=" + $script:lvisited + "/" + $maxN + " - raise depth/max or widen name; absence is NOT proven.") }',
      'elseif ($ltruncated) { $lhints += ("the walk hit the max/depth budget before finishing (depth_reached=" + $script:ldepthReached + "/" + $maxDepth + ", visited=" + $script:lvisited + "/" + $maxN + "): matches further along may exist - raise max (or narrow name/elType) if you need certainty.") }',
      'if ($lstatusFinal -eq "not-found") { $lhints += ("no element matching name=*" + $lname + "*" + $(if ($ltype) { " type=*" + $ltype + "*" } else { "" }) + " (walk finished: total=" + $script:lvisited + ") - run gui_uia action=tree to see the real names.") }',
      'if ($lstatusFinal -eq "ambiguous") { $lhints += ("matched " + $script:lhits.Count + " elements and no index was given: pass index to pick one. Candidates (first 5) are in candidates[] with their real rects/points.") }',
      'if ($lstatusFinal -eq "offscreen") { $lhints += "the element exists but is not on screen (offscreen flag, or its centre is outside the window rect): make it visible first (scroll / switch tab / activate the window) and locate again - do NOT click this coordinate." }',
      '$lcands = @()',
      'if ($lstatusFinal -eq "ambiguous") {',
      '  $lk = 0',
      '  foreach ($h in $script:lhits) {',
      '    if ($lk -ge 5) { break }',
      '    $lp = $null; if ($h["offscreen"] -ne $true) { $lp = @{ x=[int]$h["cx"]; y=[int]$h["cy"] } }',
      '    $lcands += @{ index=$lk; name=$h["name"]; type=$h["type"]; rect=@{ x=$h["x"]; y=$h["y"]; w=$h["w"]; h=$h["h"] }; point=$lp; offscreen=$h["offscreen"]; enabled=$h["enabled"] }',
      '    $lk++',
      '  }',
      '}',
      '$luiaPath = @()',
      'if ($lstatusFinal -eq "found") {',
      '  $lcur = $lselEl; $lk2 = 0',
      '  while ($null -ne $lcur -and $lk2 -lt 6) {',
      '    try { $luiaPath += (([string]$lcur.Current.ControlType.ProgrammaticName).Replace("ControlType.", "") + ":" + [string]$lcur.Current.Name) } catch {}',
      '    try { $lcur = $lwalker.GetParent($lcur) } catch { $lcur = $null }',
      '    $lk2++',
      '  }',
      '}',
      '$lout = @{ status=$lstatusFinal; space="virtual-desktop-physical"; origin=@{ x=$r.Left; y=$r.Top }; scale=1; window=$target.title; handle=$target.handle; path="uia"; total=$script:lvisited; matched=$script:lhits.Count; depth_reached=$script:ldepthReached }',
      'if ($lstatusFinal -eq "found") {',
      '  $lout["index"] = $lindex',
      '  $lout["name"] = $lsel["name"]; $lout["type"] = $lsel["type"]; $lout["enabled"] = $lsel["enabled"]; $lout["offscreen"] = $lsel["offscreen"]',
      '  $lout["rect"] = @{ x=$lsel["x"]; y=$lsel["y"]; w=$lsel["w"]; h=$lsel["h"] }',
      '  $lout["point"] = @{ x=[int]$lsel["cx"]; y=[int]$lsel["cy"] }',
      '  $lout["uiaPath"] = $luiaPath',
      '}',
      'if ($lstatusFinal -eq "offscreen") {',
      '  $lout["index"] = $lindex',
      '  $lout["name"] = $lsel["name"]; $lout["type"] = $lsel["type"]; $lout["enabled"] = $lsel["enabled"]; $lout["offscreen"] = $lsel["offscreen"]',
      '  $lout["rect"] = @{ x=$lsel["x"]; y=$lsel["y"]; w=$lsel["w"]; h=$lsel["h"] }',
      '}',
      'if ($lstatusFinal -eq "ambiguous") { $lout["candidates"] = $lcands; $lout["candidatesShown"] = $lcands.Count }',
      'if ($lstatusFinal -eq "truncated" -or $lstatusFinal -eq "found") { $lout["truncated"] = [bool]$ltruncated }',
      'if ($lhints.Count -gt 0) { $lout["hints"] = $lhints; $lout["hint"] = $lhints[0] }',
      '$lout | ConvertTo-Json -Compress -Depth 6; exit',
    ].join('\n') }
  }, 45000)
}
