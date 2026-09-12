/**
 * sage-guikit 冒烟测试挂具：stub Cordis ctx，真实执行注册的工具脚本。
 * 用法：node smoke.mjs [toolName] —— 不带参数跑 gui_screen + gui_uia 快速组。
 */
import { spawn as cpSpawn } from 'node:child_process'

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
console.log('[smoke] registered:', tools.map(t => t.name).join(', '))

const exec = { signal: undefined }
const run = async (name, args) => {
  const tool = tools.find(t => t.name === name)
  if (!tool) { console.error(`[smoke] MISSING TOOL: ${name}`); process.exitCode = 1; return }
  try {
    const value = await tool.execute(args, exec)
    console.log(`[smoke] ${name} OK →`, JSON.stringify(value).slice(0, 220))
  } catch (e) {
    console.error(`[smoke] ${name} FAILED:`, e.message.slice(0, 400))
    process.exitCode = 1
  }
}

await run('gui_screen', {})
await run('gui_screenshot', { w: 400, h: 300, annotate: true })
await run('gui_uia', { action: 'tree', title: process.argv[2] || 'DeepSeek Harness', max: 20 })
await run('gui_wait', { mode: 'pixel', x: 700, y: 700, compare: 'eq', r: 21, g: 21, b: 23, timeoutMs: 1500 })
console.log('[smoke] done')
