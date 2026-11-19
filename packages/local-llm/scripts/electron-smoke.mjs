import { app, utilityProcess } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { LocalLlmClient } from '../dist/index.mjs'

app.whenReady().then(async () => {
  try {
    const model = process.env.GENOFFICE_LFM_MODEL
    assert.ok(model, 'Set GENOFFICE_LFM_MODEL to the pinned GGUF')
    let child
    const client = new LocalLlmClient(
      () => {
        const hostEntry = app.getAppPath().endsWith('.asar')
          ? join(app.getAppPath(), 'out/main/local-llm-host.mjs').replace(
              /app\.asar([\\/])/,
              'app.asar.unpacked$1',
            )
          : fileURLToPath(new URL('../dist/host.mjs', import.meta.url))
        child = utilityProcess.fork(hostEntry, [], {
          stdio: 'pipe',
          serviceName: 'LFM native smoke',
        })
        child.stderr.on('data', (data) => process.stderr.write(data))
        child.on('message', (event) => {
          if (event.type === 'status' && event.loadTimings)
            console.log('LOAD', JSON.stringify(event.loadTimings))
        })
        return child
      },
      model,
      { contextSize: 4096, threads: 6 },
    )
    const started = performance.now()
    for (const prompt of [
      'Xin chào. Trả lời ngắn gọn bằng tiếng Việt.',
      'Soạn một email xin nghỉ phép hai ngày, tối đa 4 câu.',
    ]) {
      let answer = ''
      await client.chat(
        {
          system: 'Bạn là trợ lý văn phòng. Trả lời bằng tiếng Việt.',
          messages: [{ role: 'user', text: prompt }],
          tools: [],
          maxTokens: 180,
          thinking: false,
        },
        (event) => {
          if (event.type === 'text') answer += event.text
          if (event.type === 'usage') console.log('USAGE', JSON.stringify(event.usage))
        },
      )
      assert.ok(answer.length > 3)
      assert.ok(!answer.includes('</think>'))
      console.log('ANSWER', answer)
      console.log('LAP chat-complete ms', Math.round(performance.now() - started))
    }
    const abort = new AbortController()
    await assert.rejects(
      client.chat(
        {
          system: 'Trả lời bằng tiếng Việt.',
          messages: [{ role: 'user', text: 'Viết một bài dài 2000 từ về văn phòng.' }],
          tools: [],
          maxTokens: 2000,
        },
        (event) => {
          if (event.type === 'text') abort.abort()
        },
        abort.signal,
      ),
      (error) => error.code === 'ABORTED',
    )
    console.log('LAP abort-complete ms', Math.round(performance.now() - started))
    await client.unload()
    console.log('LAP unload-complete ms', Math.round(performance.now() - started))
    await client.shutdown()
    console.log('LAP shutdown-complete ms', Math.round(performance.now() - started))
    assert.equal(client.state, 'STOPPED')
    console.log(
      'PASS Electron',
      process.versions.electron,
      'native utility process; chat, abort, unload, awaited exit',
      Math.round(performance.now() - started),
      'ms',
    )
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
