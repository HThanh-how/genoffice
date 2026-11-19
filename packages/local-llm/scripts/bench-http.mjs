// Baseline comparison only. The production local provider never uses HTTP or llama-server.
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { verifyModel } from '../dist/index.mjs'

const modelPath = process.env.GENOFFICE_LFM_MODEL
const binary = process.env.GENOFFICE_LLAMA_SERVER
if (!modelPath || !binary)
  throw new Error('Set GENOFFICE_LFM_MODEL and GENOFFICE_LLAMA_SERVER for this optional baseline')
await verifyModel(modelPath)
const token = randomBytes(24).toString('hex')
const port = 18743
const started = performance.now()
const child = spawn(
  binary,
  [
    '-m',
    modelPath,
    '-c',
    '4096',
    '-t',
    '6',
    '-ngl',
    '0',
    '-np',
    '1',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--api-key',
    token,
    '--jinja',
    '--reasoning-budget',
    '0',
  ],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
)
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-12000)
})
let exited = false
child.on('exit', () => {
  exited = true
})
const url = `http://127.0.0.1:${port}`
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
const report = {
  version: 'llama.cpp b12110 (v0.9.0)',
  threads: 6,
  contextSize: 4096,
  measurements: [],
}
try {
  for (;;) {
    if (exited) throw new Error(stderr)
    try {
      if ((await fetch(`${url}/health`, { headers })).ok) break
    } catch {}
    if (performance.now() - started > 120000) throw new Error('Baseline server readiness timeout')
    await new Promise((r) => setTimeout(r, 100))
  }
  report.hostAndLoadMs = performance.now() - started
  for (const thinking of [false]) {
    const start = performance.now()
    let first = null
    let text = ''
    let buffer = ''
    let timings
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content:
              'Bạn là trợ lý soạn thảo văn bản. Trả lời bằng tiếng Việt. Dùng công cụ khi được yêu cầu thao tác trên tài liệu. Không tự đặt mục tiêu xóa.',
          },
          {
            role: 'user',
            content: 'Viết 5 gạch đầu dòng về lợi ích của việc họp đứng trong công ty.',
          },
        ],
        stream: true,
        max_tokens: 160,
        temperature: 0.1,
        top_k: 50,
        top_p: 1,
        min_p: 0,
        repeat_penalty: 1.1,
        reasoning_budget: thinking ? -1 : 0,
        cache_prompt: false,
      }),
    })
    if (!response.ok) throw new Error(await response.text())
    for await (const chunk of response.body) {
      buffer += new TextDecoder().decode(chunk)
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim()
        buffer = buffer.slice(i + 1)
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
        const event = JSON.parse(line.slice(6))
        const delta = event.choices?.[0]?.delta?.content
        if (delta) {
          first ??= performance.now() - start
          text += delta
        }
        if (event.timings) timings = event.timings
      }
    }
    const row = { thinking, ttftMs: first, elapsedMs: performance.now() - start, timings, text }
    const rss = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).WorkingSet64`],
      { encoding: 'utf8', windowsHide: true },
    )
    row.rssBytes = Number(rss.trim())
    report.measurements.push(row)
    console.log(JSON.stringify(row))
  }
  writeFileSync(
    process.argv[2] ?? 'local-llm-http-bench.json',
    JSON.stringify(report, null, 2) + '\n',
  )
} finally {
  if (!exited) {
    const exit = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await exit
  }
}
