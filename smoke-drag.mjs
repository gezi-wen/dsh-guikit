/**
 * gui_drag 端到端测试：起一个 WinForms 测试窗口，拖它的标题栏，验证窗口真的被拖动了。
 *
 * ⚠️ 会接管真实鼠标 1–2 秒（移到测试窗口标题栏并拖 160×90 px）。
 *    同屏有别的 agent 在跑 GUI 自动化时不要跑（见 project_guikit「同屏互斥」）。
 * 用法：node smoke-drag.mjs
 */
import { spawn as cpSpawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mod = await import('./lib/index.js').catch(() => import('sage-guikit'))

const tools = []
const ctx = {
  tools: { register: (d) => tools.push(d) },
  subprocess: {
    resolveExecutable: async (n) => n,
    spawn(spec) {
      const child = cpSpawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true })
      let out = Buffer.alloc(0)
      let err = Buffer.alloc(0)
      child.stdout.on('data', (d) => { if (out.length < 393216) out = Buffer.concat([out, d]) })
      child.stderr.on('data', (d) => { if (err.length < 131072) err = Buffer.concat([err, d]) })
      const handle = {
        collected: {
          stdout: { readFrom: () => ({ text: out.toString('utf8'), nextOffset: out.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: err.toString('utf8'), nextOffset: err.length, lossy: false }) },
        },
        terminate: () => child.kill(),
      }
      handle.done = new Promise((res) => child.on('close', (code) => res({ exitCode: code, signal: null })))
      return handle
    },
  },
  timer: { timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t) } },
}

mod.apply(ctx)
const call = (name, args) => tools.find((t) => t.name === name).execute(args, { signal: undefined })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TITLE = 'guikit-drag-test'
// 两个实测坑：
//  1) 多行脚本走 -Command 传参在这台机器上起不来窗体，写成临时 .ps1 用 -File 最稳；
//  2) windowsHide: true（CREATE_NO_WINDOW）下 WinForms 窗体创建出来是不可见的，
//     必须 windowsHide: false（配 -WindowStyle Hidden 遮住控制台）。
const formPath = join(tmpdir(), 'guikit-drag-form.ps1')
writeFileSync(formPath, [
  // DPI-aware：否则 Windows 的 DPI 虚拟化会掺进拖拽结果（DPI-unaware 窗口实测横向位移被吃掉，
  // 那是系统行为不是本插件的问题）。测的是我们自己的注入，所以先把这一项隔离掉。
  "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();'",
  '[void][W.U]::SetProcessDPIAware()',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$f = New-Object System.Windows.Forms.Form',
  `$f.Text = '${TITLE}'`,
  "$f.StartPosition = 'Manual'",
  '$f.SetBounds(700, 500, 520, 340)',
  '$f.TopMost = $true',
  '[System.Windows.Forms.Application]::Run($f)',
].join('\n'), 'utf8')

const child = cpSpawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', formPath], { windowsHide: false })
const cleanup = () => { try { child.kill() } catch {} ; try { rmSync(formPath, { force: true }) } catch {} }

let before = null
for (let i = 0; i < 40 && !before; i++) {
  await sleep(300)
  try {
    const list = await call('gui_window', { action: 'list', title: TITLE })
    before = (list.windows || []).find((w) => w.title === TITLE) || null
  } catch (e) { /* 窗口还没起 */ }
}
if (!before) {
  console.error('[drag] FAIL: 测试窗口没出现')
  cleanup()
  process.exit(1)
}
console.log('[drag] before:', JSON.stringify(before))

const dx = 160, dy = 90
const fromX = before.x + Math.round(before.w / 2)
const fromY = before.y + 12
const res = await call('gui_drag', { fromX, fromY, toX: fromX + dx, toY: fromY + dy, steps: 20, stepDelayMs: 20 })
console.log('[drag] result:', JSON.stringify(res))

await sleep(500)
const after = await call('gui_window', { action: 'rect', handle: before.handle })
const ddx = after.x - before.x
const ddy = after.y - before.y
const pass = Math.abs(ddx - dx) <= 20 && Math.abs(ddy - dy) <= 20
console.log(`[drag] moved by (${ddx},${ddy}) — expected (${dx},${dy}) -> ${pass ? 'PASS' : 'FAIL'}`)

cleanup()
process.exitCode = pass ? 0 : 1
