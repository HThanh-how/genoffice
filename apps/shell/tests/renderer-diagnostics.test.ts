import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  attachRendererDiagnostics,
  rotatingFileWriter,
} from '../src/main/fork/renderer-diagnostics'

function fakeContents(probeAnswer: string | Error = '{"rootChildren":0}') {
  const wc = new EventEmitter() as EventEmitter & {
    isDestroyed(): boolean
    getURL(): string
    executeJavaScript(script: string): Promise<unknown>
  }
  let destroyed = false
  wc.isDestroyed = () => destroyed
  wc.getURL = () => 'file:///app/sheets/index.html'
  wc.executeJavaScript = () =>
    probeAnswer instanceof Error ? Promise.reject(probeAnswer) : Promise.resolve(probeAnswer)
  return {
    wc: wc as unknown as WebContents,
    emit: wc.emit.bind(wc),
    destroy() {
      destroyed = true
      wc.emit('destroyed')
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('the tab diagnostics record', () => {
  it('notes the page loading, failing, dying and hanging', () => {
    const lines: string[] = []
    const { wc, emit } = fakeContents()
    attachRendererDiagnostics(wc, 'sheets a.xlsx', (l) => lines.push(l))
    emit('did-finish-load')
    emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///x.html')
    emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 })
    emit('unresponsive')
    emit('preload-error', {}, '/p.js', new Error('boom'))
    const text = lines.join('\n')
    expect(text).toContain('[sheets a.xlsx] created')
    expect(text).toContain('did-finish-load')
    expect(text).toContain('did-fail-load -3 ERR_ABORTED')
    expect(text).toContain('render-process-gone crashed exit=5')
    expect(text).toContain('unresponsive')
    expect(text).toContain('preload-error /p.js')
  })

  it('keeps console warnings and errors only, in either calling style', () => {
    const lines: string[] = []
    const { wc, emit } = fakeContents()
    attachRendererDiagnostics(wc, 't', (l) => lines.push(l))
    emit('console-message', { level: 'info', message: 'chatty', lineNumber: 1, sourceId: 'a.js' })
    emit('console-message', {
      level: 'error',
      message: 'Univer failed',
      lineNumber: 7,
      sourceId: 'app/index.js',
    })
    emit('console-message', {}, 2, 'old style warning', 9, 'b.js')
    const text = lines.join('\n')
    expect(text).not.toContain('chatty')
    expect(text).toContain('error Univer failed (app/index.js:7)')
    expect(text).toContain('old style warning')
  })

  it('probes what is on the page after a few seconds, and says if the probe itself fails', async () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const { wc } = fakeContents('{"rootChildren":0,"canvases":0}')
    attachRendererDiagnostics(wc, 't', (l) => lines.push(l), [1000])
    await vi.advanceTimersByTimeAsync(1100)
    expect(lines.join('\n')).toContain('probe@1s {"rootChildren":0,"canvases":0}')
    const bad = fakeContents(new Error('no frame'))
    const lines2: string[] = []
    attachRendererDiagnostics(bad.wc, 't', (l) => lines2.push(l), [1000])
    await vi.advanceTimersByTimeAsync(1100)
    expect(lines2.join('\n')).toContain('probe@1s failed')
  })

  it('does not probe a page that is already gone', async () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const { wc, destroy } = fakeContents()
    attachRendererDiagnostics(wc, 't', (l) => lines.push(l), [1000])
    destroy()
    await vi.advanceTimersByTimeAsync(2000)
    expect(lines.join('\n')).not.toContain('probe@')
    expect(lines.join('\n')).toContain('destroyed')
  })
})

describe('the rotating log file', () => {
  it('starts a new file when the old one is too big, and never throws', () => {
    const calls: string[] = []
    let size = 10
    const write = rotatingFileWriter(
      '/logs/tabs.log',
      {
        append: (_p, t) => void calls.push(`append ${t.trim()}`),
        size: () => size,
        rename: (a, b) => void calls.push(`rename ${a} ${b}`),
      },
      100,
    )
    write('one')
    size = 500
    write('two')
    expect(calls).toEqual(['append one', 'rename /logs/tabs.log /logs/tabs.log.1', 'append two'])
    const broken = rotatingFileWriter('/x', {
      append: () => {
        throw new Error('disk full')
      },
      size: () => 0,
      rename: () => undefined,
    })
    expect(() => broken('line')).not.toThrow()
  })
})
