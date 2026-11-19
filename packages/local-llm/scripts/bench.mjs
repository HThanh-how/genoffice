import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { cpus, totalmem, freemem, release } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DEFAULT_LOCAL_OPTIONS, verifyModel } from '../dist/index.mjs'

const modelPath = process.env.GENOFFICE_LFM_MODEL
if (!modelPath) throw new Error('Set GENOFFICE_LFM_MODEL; integrity is always checked')
const output = process.argv[2] ?? 'local-llm-bench.json'
const contextOnly = Number(process.argv.find((arg) => arg.startsWith('--context='))?.split('=')[1])
const report = {
  at: new Date().toISOString(),
  hardware: {
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    totalGiB: totalmem() / 1024 ** 3,
    freeGiB: freemem() / 1024 ** 3,
    os: release(),
    node: process.version,
  },
  measurements: [],
  tools: [],
}
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
const system =
  'Bạn là trợ lý soạn thảo văn bản. Trả lời bằng tiếng Việt. Dùng công cụ khi được yêu cầu thao tác trên tài liệu. Không tự đặt mục tiêu xóa.'
const started = performance.now()
await verifyModel(modelPath)
report.hashMs = performance.now() - started
save()

async function open(threads, contextSize) {
  const start = performance.now()
  const env = {}
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
  ])
    if (process.env[key]) env[key] = process.env[key]
  const child = fork(fileURLToPath(new URL('../dist/host.mjs', import.meta.url)), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced',
    windowsHide: true,
    env,
  })
  child.stderr.on('data', (data) => process.stderr.write(data))
  const pending = new Map()
  child.on('message', (event) => {
    const call = pending.get(event.id)
    if (!call) return
    call.events.push(event)
    if (event.type === 'done' || event.type === 'error') {
      clearTimeout(call.timer)
      pending.delete(event.id)
      if (event.type === 'error')
        call.reject(
          Object.assign(new Error(event.message), { code: event.code, events: call.events }),
        )
      else call.resolve(call.events)
    }
  })
  child.on('exit', (code) => {
    for (const call of pending.values()) {
      clearTimeout(call.timer)
      call.reject(new Error(`Host exited ${code}`))
    }
    pending.clear()
  })
  const rpc = (message) =>
    new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        child.send({ id: randomUUID(), type: 'abort', requestId: id })
        setTimeout(() => child.kill(), 3000).unref()
        pending.delete(id)
        reject(new Error('Benchmark request timed out after 90 seconds'))
      }, 90000)
      pending.set(id, { resolve, reject, events: [], timer })
      child.send({ ...message, id })
    })
  await rpc({ type: 'ping' })
  const hostStartMs = performance.now() - start
  const loadStart = performance.now()
  await rpc({
    type: 'load',
    modelPath,
    options: { ...DEFAULT_LOCAL_OPTIONS, threads, contextSize },
  })
  const loadMs = performance.now() - loadStart
  console.log('LOADED', threads, contextSize, Math.round(hostStartMs), Math.round(loadMs))
  const loadStatus = (await rpc({ type: 'status' })).find((e) => e.type === 'status')
  report.measurements.push({
    kind: 'load',
    threads,
    contextSize,
    effectiveContextSize: loadStatus.contextSize,
    hostStartMs,
    loadMs,
    totalMs: performance.now() - start,
    rssBytes: loadStatus.rssBytes,
  })
  save()
  const chat = async (label, prompt, thinking = false, tools = [], maxTokens = 160) => {
    const start = performance.now()
    let events
    try {
      events = await rpc({
        type: 'chat',
        request: { system, messages: [{ role: 'user', text: prompt }], tools, maxTokens, thinking },
      })
    } catch (error) {
      if (error.message.includes('timed out') && child.exitCode === null)
        await new Promise((resolve) => child.once('exit', resolve))
      const row = {
        kind: 'chat',
        label,
        threads,
        contextSize,
        thinking,
        wallMs: performance.now() - start,
        error: error.message,
        events: error.events ?? [],
      }
      report.measurements.push(row)
      save()
      console.log('ERROR', label, threads, error.message)
      return row
    }
    const usage = events.find((e) => e.type === 'usage')?.usage
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.text)
      .join('')
    const calls = events.filter((e) => e.type === 'toolcall').map((e) => e.call)
    const row = {
      kind: 'chat',
      label,
      threads,
      contextSize,
      thinking,
      wallMs: performance.now() - start,
      ...usage,
      text,
      calls,
    }
    if (usage?.ttftMs !== null) {
      row.generationTokensPerSecond =
        (usage.outputTokens - usage.thoughtTokens - 1) / ((usage.elapsedMs - usage.ttftMs) / 1000)
      row.promptTokensPerSecond = usage.evaluatedPromptTokens / (usage.ttftMs / 1000)
    }
    report.measurements.push(row)
    save()
    console.log(
      'CHAT',
      label,
      threads,
      contextSize,
      Math.round(usage?.ttftMs ?? 0),
      row.generationTokensPerSecond?.toFixed(1),
    )
    return row
  }
  const close = async () => {
    if (child.exitCode !== null || child.killed) return
    await rpc({ type: 'unload' })
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.send({ id: randomUUID(), type: 'shutdown' })
    await exited
  }
  return { chat, close }
}

for (const threads of contextOnly ? [] : [4, 6, 8, 16]) {
  const host = await open(threads, 4096)
  await host.chat('short-off', 'Viết 5 gạch đầu dòng về lợi ích của việc họp đứng trong công ty.')
  if (threads !== 16)
    await host.chat(
      'short-on',
      'Viết 5 gạch đầu dòng về lợi ích của việc họp đứng trong công ty.',
      true,
    )
  await host.close()
}
for (const contextSize of contextOnly ? [contextOnly] : [4096, 16384, 32768]) {
  const host = await open(6, contextSize)
  await host.chat('short-context', 'Soạn email xin nghỉ phép 2 ngày, tối đa 5 câu.')
  // Repeated public synthetic Vietnamese text; actual prompt tokens are reported by the host tokenizer.
  for (const repeats of contextSize === 4096 ? [40] : [40, 165]) {
    const prompt =
      'Chỉ tóm tắt đoạn sau trong một câu: ' +
      'Nhóm văn phòng họp vào thứ hai. Báo cáo quý cần ghi rõ kết quả và kế hoạch tiếp theo. '.repeat(
        repeats,
      )
    await host.chat(`prefill-${repeats}`, prompt, false, [], 48)
  }
  if (contextSize === 16384) {
    const tools = [
      {
        name: 'insertText',
        description: 'Chèn văn bản vào tài liệu',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' }, position: { enum: ['start', 'end'] } },
          required: ['text', 'position'],
        },
      },
      {
        name: 'deleteBlocks',
        description: 'Xóa các khối có id cụ thể. Bắt buộc target.',
        inputSchema: {
          type: 'object',
          properties: {
            target: {
              type: 'object',
              properties: { blockIds: { type: 'array', items: { type: 'string' } } },
              required: ['blockIds'],
            },
          },
          required: ['target'],
        },
      },
      {
        name: 'readBlocks',
        description: 'Đọc các khối theo id',
        inputSchema: {
          type: 'object',
          properties: { blockIds: { type: 'array', items: { type: 'string' } } },
          required: ['blockIds'],
        },
      },
    ]
    const cases = [
      ...['Báo cáo quý 3', 'Xin chào', 'Kế hoạch tuần', 'Biên bản họp', 'Cảm ơn'].map((text) => ({
        prompt: `Chèn đúng câu "${text}" vào cuối tài liệu.`,
        name: 'insertText',
        check: (p) => p.text === text && p.position === 'end',
      })),
      ...['Lịch họp', 'Mục lục', 'Giới thiệu', 'Tóm tắt', 'Thông báo'].map((text) => ({
        prompt: `Chèn đúng câu "${text}" vào đầu tài liệu.`,
        name: 'insertText',
        check: (p) => p.text === text && p.position === 'start',
      })),
      ...[['b2'], ['b2', 'b5'], ['b7'], ['b1', 'b3'], ['b9']].map((ids) => ({
        prompt: `Xóa các khối có id ${ids.join(' và ')}.`,
        name: 'deleteBlocks',
        check: (p) => JSON.stringify(p.target?.blockIds) === JSON.stringify(ids),
      })),
      ...[['b2'], ['b4', 'b6'], ['b8']].map((ids) => ({
        prompt: `Đọc các khối có id ${ids.join(' và ')}.`,
        name: 'readBlocks',
        check: (p) => JSON.stringify(p.blockIds) === JSON.stringify(ids),
      })),
      { prompt: 'Xin chào, hôm nay bạn có thể giúp gì?', name: null, check: () => true },
      {
        prompt: 'Giải thích lợi ích của mục lục, chưa sửa tài liệu.',
        name: null,
        check: () => true,
      },
    ]
    for (const test of cases) {
      const row = await host.chat('tool', test.prompt, false, tools, 160)
      const correct =
        !row.error &&
        (test.name === null
          ? row.calls.length === 0
          : row.calls.length === 1 &&
            row.calls[0].name === test.name &&
            test.check(row.calls[0].input))
      report.tools.push({
        prompt: test.prompt,
        expected: test.name,
        correct,
        calls: row.calls,
        error: row.error,
      })
      save()
    }
    const rag = await host.chat(
      'rag',
      'Dữ liệu: Dự án Hoa Sen có ngân sách 240 triệu đồng. Hạn nộp báo cáo là 18/12/2026. Người phụ trách là chị Lan. Câu hỏi: Ai phụ trách và khi nào nộp báo cáo? Chỉ dựa vào dữ liệu trên.',
      false,
      [],
      96,
    )
    report.ragCorrect = rag.text?.includes('Lan') && /18[/.]12[/.]2026/.test(rag.text)
    save()
  }
  await host.close()
}
console.log('DONE', report.tools.filter((r) => r.correct).length + '/' + report.tools.length)
