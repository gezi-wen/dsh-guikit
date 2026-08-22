/**
 * sage-guikit — Sage GUI Toolkit（Windows 桌面控制工具集）。
 *
 * 六个模型工具，全部经 PowerShell 子进程 + user32 SendInput 实现：
 *   gui_screen      双屏布局 / 虚拟桌面 / 光标位置（物理像素）
 *   gui_screenshot  全虚拟桌面 / 单屏 / 任意区域截图 → PNG 存盘
 *   gui_click       真实鼠标移动 + 点击（左/右/中键，单/双/三击）
 *   gui_type        打字：Unicode 直注（绕 IME，支持中文）或剪贴板粘贴
 *   gui_key         组合键（ctrl+s / alt+f4 / win ...）
 *   gui_window      窗口列表 / 激活（ALT-tap 前台技巧）/ 移动 / 查坐标
 *
 * 设计要点：
 *   - SetProcessDPIAware：坐标一律物理像素，多屏负坐标安全
 *   - 注入前先点目标或 activate：程序化 Focus 撞 Windows 前台锁会静默失败
 *   - 截图存 E:\workspace\sage-gui\，模型用 read_image 看图
 *   - 已知边界：UIPI 点不了管理员窗口；锁屏/UAC 安全桌面不可达
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

const ART = 'E:\\workspace\\sage-gui'
const CWD = 'E:\\workspace'

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
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
  '  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);',
  '  static INPUT MkMouse(uint flags) { var i = new INPUT(); i.type = 0; i.u.mi = new MOUSEINPUT { dwFlags = flags }; return i; }',
  '  static INPUT MkKey(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags }; return i; }',
  '  static uint Send(INPUT[] arr) { return SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT))); }',
  '  public static string Click(int x, int y, string button, int clicks) {',
  '    if (!SetCursorPos(x, y)) return "SetCursorPos failed";',
  '    System.Threading.Thread.Sleep(120);',
  '    uint downF = 0x0002, upF = 0x0004;',
  '    if (button == "right") { downF = 0x0008; upF = 0x0010; } else if (button == "middle") { downF = 0x0020; upF = 0x0040; }',
  '    for (int c = 0; c < clicks; c++) { Send(new INPUT[] { MkMouse(downF), MkMouse(upF) }); System.Threading.Thread.Sleep(60); }',
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
  '}',
].join('\n')

const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "New-Item -ItemType Directory -Force -Path '" + ART + "' | Out-Null",
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  "Add-Type -TypeDefinition @'\n" + CS_HELPERS + "\n'@",
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

export const name = 'sage-guikit'

export const inject = ['tools', 'subprocess', 'timer']

export function apply(ctx) {
  const subprocess = ctx.subprocess
  const timer = ctx.timer
  let pwshPath = null

  async function runPs(script, signal, timeoutMs) {
    if (pwshPath === null) {
      try { pwshPath = await subprocess.resolveExecutable('pwsh') } catch (e) { pwshPath = 'pwsh' }
    }
    const handle = subprocess.spawn({
      argv: [pwshPath, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      cwd: CWD,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 131072 } },
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
      throw new Error(toolName + ': pwsh exit=' + run.exitCode + ' no JSON. stderr tail: ' + (run.stderr || '').slice(-400))
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
        return value
      },
    }))
  }

  // ── gui_screen ─────────────────────────────────────────────────────────
  registerGuiTool({
    name: 'gui_screen',
    description: 'List monitor layout of this Windows PC: per-screen bounds in physical pixels, virtual desktop rect, current cursor position. Multi-monitor: secondary screens may have negative X/Y. Call this before any coordinate-based gui_click/gui_screenshot.',
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
  ].join('\n') }), 10000)

  // ── gui_screenshot ─────────────────────────────────────────────────────
  registerGuiTool({
    name: 'gui_screenshot',
    description: 'Capture the Windows screen to a PNG file and return its path (view it with read_image). Give a region (x,y,w,h in physical pixels) OR a screen index, or nothing for the whole virtual desktop. Passive: moves nothing.',
    parameters: {
      screen: { type: 'number', description: 'Monitor index from gui_screen; captures that whole screen' },
      x: { type: 'number', description: 'Region left (virtual-desktop physical pixels)' },
      y: { type: 'number', description: 'Region top' },
      w: { type: 'number', description: 'Region width' },
      h: { type: 'number', description: 'Region height' },
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
    '$gr.Dispose()',
    '$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$bmp.Dispose()',
    '@{ path=$path; x=[int]$b.x; y=[int]$b.y; w=[int]$b.w; h=[int]$b.h; bytes=(Get-Item $path).Length } | ConvertTo-Json -Compress -Depth 3',
  ].join('\n') }), 20000)

  // ── gui_click ──────────────────────────────────────────────────────────
  registerGuiTool({
    name: 'gui_click',
    description: 'Move the REAL mouse cursor to (x,y) physical pixels and click. This takes over the user mouse briefly. button: left(default)/right/middle; clicks: 1=single 2=double 3=triple. Coordinates are virtual-desktop physical pixels (secondary screens can be negative) - get them from gui_screen or a screenshot.',
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
      '$p = New-Object POINT',
      '[void][U32]::GetCursorPos([ref]$p)',
      '@{ result=$res; x=$p.X; y=$p.Y } | ConvertTo-Json -Compress',
    ].join('\n') }
  }, 12000)

  // ── gui_type ───────────────────────────────────────────────────────────
  registerGuiTool({
    name: 'gui_type',
    description: 'Type text into the currently FOCUSED control. Unicode mode (default) injects every character incl. Chinese via SendInput; clipboard mode writes the text to the clipboard (OVERWRITES user clipboard) and pastes with Ctrl+V. Optionally click (x,y) first to move focus there. Windows foreground rule: typing lands on whatever has focus - click first or activate a window first.',
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
      '@{ result=$res; mode=$mode } | ConvertTo-Json -Compress',
    ].join('\n') }
  }, 20000)

  // ── gui_key ────────────────────────────────────────────────────────────
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

  // ── gui_window ─────────────────────────────────────────────────────────
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
}
