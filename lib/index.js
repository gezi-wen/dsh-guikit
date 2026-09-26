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
          value.delivery = {
            sent: true,
            verified: false,
            note: 'Input was SENT, not confirmed: the events reached the OS, which does not mean the target reacted. Confirm with gui_verify (element/window) or gui_wait (pixel) before trusting this result.',
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
    '  $screens += @{ index=$i; device=$s.DeviceName; primary=$s.Primary; x=$s.Bounds.X; y=$s.Bounds.Y; w=$s.Bounds.Width; h=$s.Bounds.Height }',
    '  $i++',
    '}',
    '$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$p = New-Object POINT',
    '[void][U32]::GetCursorPos([ref]$p)',
    '@{ screens=$screens; virtual=@{ x=$vs.X; y=$vs.Y; w=$vs.Width; h=$vs.Height }; cursor=@{ x=$p.X; y=$p.Y } } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n') }), 20000)

  registerGuiTool({
    name: 'gui_screenshot',
    description: 'Capture the Windows screen to a PNG file and return its path (view it with read_image). Give a region (x,y,w,h physical pixels) OR a screen index, or nothing for the whole virtual desktop. For a single window use gui_window_shot. annotate=true draws a coordinate grid with labels at every 2nd intersection (read the labels and report exact click coordinates - zero DPI math) plus a red crosshair at the current cursor position. Passive: moves nothing.',
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
    '  $lblFont = New-Object System.Drawing.Font -ArgumentList Consolas, 12, ([System.Drawing.FontStyle]::Bold)',
    '  $bgBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(165, 0, 0, 0))',
    '  $txtBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 130, 255, 130))',
    '  $startX = [Math]::Ceiling($baseX / $step) * $step',
    '  $startY = [Math]::Ceiling($baseY / $step) * $step',
    '  for ($gx = $startX; $gx -le $baseX + [int]$b.w; $gx += $step) { $lx = $gx - $baseX; $gr.DrawLine($gridPen, $lx, 0, $lx, [int]$b.h) }',
    '  for ($gy = $startY; $gy -le $baseY + [int]$b.h; $gy += $step) { $ly = $gy - $baseY; $gr.DrawLine($gridPen, 0, $ly, [int]$b.w, $ly) }',
    '  $ci = 0',
    '  for ($gx = $startX; $gx -le $baseX + [int]$b.w; $gx += $step) {',
    '    $ri = 0',
    '    for ($gy = $startY; $gy -le $baseY + [int]$b.h; $gy += $step) {',
    '      if (($ci % 2 -eq 0) -and ($ri % 2 -eq 0)) {',
    '        $text = "$gx,$gy"',
    '        $sz = $gr.MeasureString($text, $lblFont)',
    '        $lw = [int]$sz.Width + 6; $lh = [int]$sz.Height + 2',
    '        $lx = $gx - $baseX + 3; $ly = $gy - $baseY + 2',
    '        if ($lx + $lw -gt [int]$b.w) { $lx = $gx - $baseX - $lw - 3 }',
    '        if ($ly + $lh -gt [int]$b.h) { $ly = $gy - $baseY - $lh - 2 }',
    '        [void]$gr.FillRectangle($bgBrush, $lx, $ly, $lw, $lh)',
    '        $gr.DrawString($text, $lblFont, $txtBrush, $lx, $ly)',
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
    '  $gridPen.Dispose(); $lblFont.Dispose(); $bgBrush.Dispose(); $txtBrush.Dispose()',
    '}',
    '$gr.Dispose()',
    '$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$bmp.Dispose()',
    '@{ path=$path; x=[int]$b.x; y=[int]$b.y; w=[int]$b.w; h=[int]$b.h; bytes=(Get-Item $path).Length } | ConvertTo-Json -Compress -Depth 3',
  ].join('\n') }), 25000)

  // 单独成工具、脚本写瘦的理由：把「枚举窗口标题 + GetWindowRect + PrintWindow + 画网格」
  // 全塞进 gui_screenshot 一个脚本时，Windows Defender 会经 AMSI 直接拦（「此脚本包含恶意内容」，
  // 实测稳定复现、3/3）。拆出来并压到极简形态后不再被拦。
  registerGuiTool({
    name: 'gui_window_shot',
    description: 'Capture ONE window to a PNG file and return its path (view it with read_image). Target by window (title substring, topmost match) or handle (from gui_window list; takes precedence). Uses PrintWindow, so the window does NOT need to be on top - it still captures correctly when partly covered, and it never activates or moves anything. Convert image coordinates to screen coordinates with screen = origin + image * scale (the result reports x/y origin and scale; scale is 1 for DPI-aware windows and >1 for DPI-unaware ones, whose content is rendered at logical scale). annotate=true draws the coordinate grid into the image, labelled in absolute screen px. A minimized window renders black. Passive: moves nothing.',
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
      'if ($w -lt 1 -or $h -lt 1 -or $w -gt 8000 -or $h -gt 4000) { @{ error=("bad window size " + $w + "x" + $h) } | ConvertTo-Json -Compress; exit }',
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
      '  $fnt = New-Object System.Drawing.Font -ArgumentList Consolas, 12, ([System.Drawing.FontStyle]::Bold)',
      '  $bg = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(165, 0, 0, 0))',
      '  $fg = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 130, 255, 130))',
      '  $ci = 0',
      '  for ($gx = [Math]::Ceiling($r.Left / $st) * $st; $gx -le $r.Left + $w; $gx += $st) {',
      '    $lx = $gx - $r.Left',
      '    $gr.DrawLine($pen, $lx, 0, $lx, $h)',
      '    $ri = 0',
      '    for ($gy = [Math]::Ceiling($r.Top / $st) * $st; $gy -le $r.Top + $h; $gy += $st) {',
      '      $ly = $gy - $r.Top',
      '      if ($ci -eq 0) { $gr.DrawLine($pen, 0, $ly, $w, $ly) }',
      '      if (($ci % 2) -eq 0 -and ($ri % 2) -eq 0) {',
      '        $t = "$gx,$gy"; $sz = $gr.MeasureString($t, $fnt)',
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
      '  $pen.Dispose(); $fnt.Dispose(); $bg.Dispose(); $fg.Dispose()',
      '}',
      '$gr.Dispose()',
      '$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)',
      '$bmp.Dispose()',
      '@{ path=$path; x=$r.Left; y=$r.Top; w=$w; h=$h; scale=$scale; bytes=(Get-Item $path).Length; capture=$mode; handle=$hwnd.ToInt64() } | ConvertTo-Json -Compress',
    ].join('\n') }
  }, 25000)

  registerGuiTool({
    name: 'gui_click',
    description: 'Move the REAL mouse cursor to (x,y) physical pixels and click. Takes over the user mouse briefly. button left(default)/right/middle; clicks 1=single 2=double 3=triple. Coordinates are virtual-desktop physical pixels (secondary screens negative) - get them from gui_screen or annotated gui_screenshot. Result echoes the focused window so misdirected clicks are visible immediately.',
    parameters: {
      x: { type: 'number', required: true, description: 'Target X (physical px)' },
      y: { type: 'number', required: true, description: 'Target Y (physical px)' },
      button: { type: 'string', description: 'left | right | middle' },
      clicks: { type: 'number', description: '1 single, 2 double, 3 triple' },
    },
  }, (args) => {
    if (typeof args.x !== 'number' || typeof args.y !== 'number') throw new Error('gui_click needs numeric x and y')
    return { json: JSON.stringify({ x: args.x, y: args.y, button: args.button || 'left', clicks: Math.max(1, Math.min(3, args.clicks || 1)) }), body: [
      '$res = [U32]::Click([int]$g.x, [int]$g.y, [string]$g.button, [int]$g.clicks)',
      'Start-Sleep -Milliseconds 150',
      '$p = New-Object POINT',
      '[void][U32]::GetCursorPos([ref]$p)',
      '$fgParts = ([U32]::FgTitle()).Split([char]124, 2)',
      '@{ result=$res; x=$p.X; y=$p.Y; requested=@{ x=[int]$g.x; y=[int]$g.y }; fgHandle=[int64]$fgParts[0]; fgTitle=[string]$fgParts[1] } | ConvertTo-Json -Compress -Depth 3',
    ].join('\n') }
  }, 12000)

  registerGuiTool({
    name: 'gui_drag',
    description: 'Press the mouse at (fromX,fromY), move to (toX,toY) while holding, then release - a real drag: select text, move or resize a window by its title bar/border, drag a slider or scrollbar, drag-and-drop a file. Movement is interpolated (SetCursorPos alone does not produce drag events for most apps). Coordinates are virtual-desktop physical pixels; get them from gui_screen or annotated gui_screenshot. Takes over the user mouse briefly. The button is released even if movement fails. Result echoes the focused window.',
    parameters: {
      fromX: { type: 'number', required: true, description: 'Press point X (physical px)' },
      fromY: { type: 'number', required: true, description: 'Press point Y (physical px)' },
      toX: { type: 'number', required: true, description: 'Release point X (physical px)' },
      toY: { type: 'number', required: true, description: 'Release point Y (physical px)' },
      button: { type: 'string', description: 'left (default) | right | middle' },
      steps: { type: 'number', description: 'Interpolated move steps (default 16, max 120). Raise for apps that only accept slow drags' },
      stepDelayMs: { type: 'number', description: 'Delay per step in ms (default 16, max 250)' },
    },
  }, (args) => {
    for (const k of ['fromX', 'fromY', 'toX', 'toY']) {
      if (typeof args[k] !== 'number') throw new Error('gui_drag needs numeric ' + k)
    }
    return { json: JSON.stringify({ fromX: args.fromX, fromY: args.fromY, toX: args.toX, toY: args.toY, button: args.button || 'left', steps: args.steps || 16, stepDelayMs: args.stepDelayMs || 16 }), body: [
      '$res = [U32]::Drag([int]$g.fromX, [int]$g.fromY, [int]$g.toX, [int]$g.toY, [string]$g.button, [int]$g.steps, [int]$g.stepDelayMs)',
      'Start-Sleep -Milliseconds 150',
      '$p = New-Object POINT',
      '[void][U32]::GetCursorPos([ref]$p)',
      '$fgParts = ([U32]::FgTitle()).Split([char]124, 2)',
      '@{ result=$res; x=$p.X; y=$p.Y; fgHandle=[int64]$fgParts[0]; fgTitle=$fgParts[1] } | ConvertTo-Json -Compress',
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
      '$timeout = 5000; if ($g.timeoutMs) { $timeout = [int]$g.timeoutMs }; if ($timeout -gt 55000) { $timeout = 55000 }; if ($timeout -lt 200) { $timeout = 200 }',
      '$need = 2; if ($g.stableSamples) { $need = [int]$g.stableSamples }; if ($need -lt 1) { $need = 1 }; if ($need -gt 5) { $need = 5 }',
      '$interval = 250; if ($g.intervalMs) { $interval = [Math]::Max(80, [int]$g.intervalMs) }',
      '$mode = [string]$g.mode',
      'Add-Type -AssemblyName UIAutomationClient',
      'Add-Type -AssemblyName UIAutomationTypes',
      '$walkMax = 4000; $depthMax = 14',
      'function Find-Win {',
      '  if ($null -ne $g.handle) { try { return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$g.handle) } catch { return $null } }',
      '  if ($g.title) {',
      '    $wc = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Window)',
      '    $wins = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $wc)',
      '    foreach ($w in $wins) { try { if ($w.Current.Name -like ("*" + $g.title + "*")) { return $w } } catch {} }',
      '    return $null',
      '  }',
      '  return [System.Windows.Automation.AutomationElement]::FromForeground()',
      '}',
      '$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
      'function Find-El($root) {',
      '  $script:vfound = $null; $script:vseen = 0',
      '  function Walk($el, $d) {',
      '    if ($d -gt $depthMax -or $null -ne $script:vfound -or $script:vseen -gt $walkMax) { return }',
      '    $c = $walker.GetFirstChild($el)',
      '    while ($null -ne $c) {',
      '      $script:vseen = $script:vseen + 1',
      '      try {',
      '        $nm = [string]$c.Current.Name',
      '        $tn = [string]($c.Current.ControlType.ProgrammaticName -replace "^ControlType\\\\.", "")',
      '        $nameOk = (-not $g.name) -or ($nm -like ("*" + $g.name + "*"))',
      '        $typeOk = (-not $g.elType) -or ($tn -like ("*" + $g.elType + "*"))',
      '        if ($nameOk -and $typeOk) { $script:vfound = $c; return }',
      '      } catch {}',
      '      Walk $c ($d + 1)',
      '      if ($null -ne $script:vfound) { return }',
      '      $c = $walker.GetNextSibling($c)',
      '    }',
      '  }',
      '  Walk $root 0',
      '  return $script:vfound',
      '}',
      '$sw = [System.Diagnostics.Stopwatch]::StartNew()',
      '$streak = 0; $tries = 0; $ok = $null; $why = "not evaluated"; $obs = $null; $decided = $false',
      'while ($sw.ElapsedMilliseconds -lt $timeout) {',
      '  $tries = $tries + 1',
      '  $ok = $null; $obs = $null',
      '  $target = Find-Win',
      '  if ($null -eq $target) { $why = "target window not found" }',
      '  elseif ($mode -eq "window") {',
      '    $r = $target.Current.BoundingRectangle',
      '    $obs = @{ title=[string]$target.Current.Name; x=[int]$r.X; y=[int]$r.Y; w=[int]$r.Width; h=[int]$r.Height }',
      '    if ($null -ne $g.boundsW) {',
      '      $tol = 8; if ($g.tolerancePx) { $tol = [int]$g.tolerancePx }',
      '      $dx = [Math]::Abs([int]$r.X - [int]$g.boundsX); $dy = [Math]::Abs([int]$r.Y - [int]$g.boundsY)',
      '      $dw = [Math]::Abs([int]$r.Width - [int]$g.boundsW); $dh = [Math]::Abs([int]$r.Height - [int]$g.boundsH)',
      '      $ok = ($dx -le $tol) -and ($dy -le $tol) -and ($dw -le $tol) -and ($dh -le $tol)',
      '      $why = "bounds delta " + $dx + "/" + $dy + "/" + $dw + "/" + $dh + " tol " + $tol',
      '    } else { $ok = $true; $why = "window present" }',
      '  }',
      '  else {',
      '    $el = Find-El $target',
      '    if ($null -eq $el) { $why = "element not found (UIA walk is not exhaustive)" }',
      '    else {',
      '      $ok = $true; $why = "element found"',
      '      $obs = @{ name=[string]$el.Current.Name; type=[string]($el.Current.ControlType.ProgrammaticName -replace "^ControlType\\\\.", ""); enabled=$el.Current.IsEnabled }',
      '      if ($g.enabled -eq $true -and -not $el.Current.IsEnabled) { $ok = $false; $why = "element is disabled" }',
      '      if ($null -ne $g.valueEquals) {',
      '        $val = $null',
      '        try { $val = ($el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value } catch {}',
      '        $obs.value = $val',
      '        if ($null -eq $val) { $ok = $null; $why = "element exposes no ValuePattern" }',
      '        elseif ($val -ne [string]$g.valueEquals) { $ok = $false; $why = "value differs from expectation" }',
      '        else { $why = "value matches" }',
      '      }',
      '    }',
      '  }',
      '  if ($ok -eq $true) { $streak = $streak + 1 } else { $streak = 0 }',
      '  if ($streak -ge $need) { $decided = $true; break }',
      '  Start-Sleep -Milliseconds $interval',
      '}',
      '$verdict = "unsatisfied"',
      'if ($decided) { $verdict = "satisfied" } elseif ($null -eq $ok) { $verdict = "unknown" }',
      '@{ verdict=$verdict; mode=$mode; elapsedMs=$sw.ElapsedMilliseconds; tries=$tries; streak=$streak; required=$need; detail=$why; observed=$obs } | ConvertTo-Json -Compress -Depth 4',
    ].join('\n') }
  }, 60000)

  registerGuiTool({
    name: 'gui_uia',
    description: 'Windows UI Automation structured query on ONE window - the precision path for standard controls. Target by handle (from gui_window) or title substring, else the foreground window. action=tree lists interactables (name/type/rect/enabled); action=find locates elements whose Name contains `name` and/or whose control type matches `elType`; action=invoke presses the first match via InvokePattern (fallback TogglePattern) holding the live element - most reliable button press, no coordinates needed; action=value reads an edit/document element text via ValuePattern - verify typed content without screenshots. Rects are physical pixels usable with gui_click directly.',
    parameters: {
      action: { type: 'string', required: true, description: 'tree | find | invoke | value' },
      handle: { type: 'number', description: 'Target window handle (from gui_window list)' },
      title: { type: 'string', description: 'Or target window by title substring' },
      name: { type: 'string', description: 'Element Name substring' },
      elType: { type: 'string', description: 'Control type substring like Edit/Button/ListItem' },
      depth: { type: 'number', description: 'Tree depth limit (default 10)' },
      max: { type: 'number', description: 'Max elements visited (default 300)' },
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
      '  $target = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$g.handle)',
      '} elseif ($g.title) {',
      '  $wcond = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Window)',
      '  $wins = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $wcond)',
      '  foreach ($w in $wins) { try { if ($w.Current.Name -like ("*" + $g.title + "*")) { $target = $w; break } } catch {} }',
      '} else {',
      '  $target = [System.Windows.Automation.AutomationElement]::FromForeground()',
      '}',
      'if ($null -eq $target) { @{ error="target window not found" } | ConvertTo-Json -Compress; exit }',
      '$maxDepth = 10; if ($g.depth) { $maxDepth = [Math]::Min(20, [int]$g.depth) }',
      '$maxN = 300; if ($g.max) { $maxN = [Math]::Min(800, [int]$g.max) }',
      '$filter = ""; if ($g.name) { $filter = [string]$g.name }',
      '$typeFilter = ""; if ($g.elType) { $typeFilter = [string]$g.elType }',
      '$action = [string]$g.action',
      '$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
      '$script:rows = New-Object System.Collections.ArrayList',
      '$script:firstEl = $null',
      'function Visit-El($el, $depth) {',
      '  if ($depth -gt $maxDepth -or $script:rows.Count -ge $maxN) { return }',
      '  $child = $walker.GetFirstChild($el)',
      '  while ($null -ne $child -and $script:rows.Count -lt $maxN) {',
      '    try {',
      '      $c = $child.Current',
      '      $r = $c.BoundingRectangle',
      '      $nm = [string]$c.Name',
      '      $tn = [string]($c.ControlType.ProgrammaticName -replace "^ControlType\\\\.", "")',
      '      $nameOk = ($filter -eq "") -or ($nm -like ("*" + $filter + "*"))',
      '      $typeOk = ($typeFilter -eq "") -or ($tn -like ("*" + $typeFilter + "*"))',
      '      if ($nameOk -and $typeOk) {',
      '        [void]$script:rows.Add(@{ name=$nm; type=$tn; x=[int]$r.X; y=[int]$r.Y; w=[int]$r.Width; h=[int]$r.Height; enabled=$c.IsEnabled; offscreen=$c.IsOffscreen })',
      '        if ($action -ne "tree" -and $null -eq $script:firstEl) { $script:firstEl = $child }',
      '      }',
      '    } catch {}',
      '    Visit-El $child ($depth + 1)',
      '    $child = $walker.GetNextSibling($child)',
      '  }',
      '}',
      'Visit-El $target 0',
      'if ($action -eq "tree" -or $action -eq "find") {',
      '  @{ window=$target.Current.Name; count=$script:rows.Count; elements=@($script:rows) } | ConvertTo-Json -Compress -Depth 4; exit',
      '}',
      'if ($null -eq $script:firstEl) { @{ error=("no element matching" + $(if ($filter) { " name=" + $filter } else { "" }) + $(if ($typeFilter) { " type=" + $typeFilter } else { "" })); hint="run action=tree to inspect" } | ConvertTo-Json -Compress; exit }',
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
}
