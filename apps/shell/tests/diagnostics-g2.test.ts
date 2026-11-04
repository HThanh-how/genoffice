import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setDiagSink } from '@genoffice/ai-provider/diag-hook'
import { appendBootstrapLog } from '../src/main/document-memory/bootstrap-log'

const root = join(__dirname, '..', '..')
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8')
const dirs: string[] = []
afterEach(() => {
  setDiagSink(undefined)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('the document-memory log goes to the diagnostic log too', () => {
  it('forwards each line, with its level, and still writes document-memory.log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'g2-'))
    dirs.push(dir)
    const entries: Array<{ level: string; ev: string; data: any }> = []
    const mk = (level: string) => (_c: string, ev: string, data?: unknown) =>
      void entries.push({ level, ev, data })
    setDiagSink({ info: mk('info'), warn: mk('warn'), error: mk('error') })
    appendBootstrapLog(dir, 'warn', 'queue not advancing: reason=stalled waiting=3')
    appendBootstrapLog(dir, 'error', 'Document memory is unavailable (fail-closed)')
    expect(entries.map((e) => [e.level, e.ev])).toEqual([
      ['warn', 'bootstrap'],
      ['error', 'bootstrap'],
    ])
    expect(entries[0]!.data.detail).toContain('queue not advancing')
    expect(readFileSync(join(dir, 'document-memory.log'), 'utf8')).toContain('queue not advancing')
  })
})

describe('where the events are written (wiring of the app)', () => {
  it('registers the logger as the sink of the code that has none', () => {
    expect(read('shell', 'src', 'main', 'index.ts')).toContain('setDiagSink(diag)')
  })

  it('writes the life of an AI request: start, first text, silence, end, abort, failure', () => {
    const docs = read('docs', 'src', 'main', 'docs-main.ts')
    for (const ev of [
      'request.start',
      'request.first-text',
      'request.silent',
      'request.end',
      'request.aborted',
      'request.failed',
    ]) {
      expect(docs, ev).toContain(`'${ev}'`)
    }
    // every one of them carries the id of the request
    const start = docs.indexOf("diagHook.info('ai', 'request.start'")
    expect(docs.slice(start, start + 600)).toContain('reqId: requestId')
    // and the silence timer is cleared when the request ends
    expect(docs).toContain('clearInterval(silenceTimer)')
  })

  it('passes the request id to the agy run, which writes how it ended', () => {
    const agy = read('..', 'packages', 'ai-provider', 'src', 'agy-cli.ts')
    expect(agy).toContain('...(cb.requestId ? { reqId: cb.requestId } : {})')
    expect(agy).toContain("diagHook.warn('ai', 'agy.failed'")
    expect(agy).toContain("diagHook.info('ai', 'agy.run'")
    expect(agy).toContain("observeChild(child, 'agy-run', options.reqId)")
  })

  it('observes the child processes of the app by a fixed label', () => {
    expect(read('shell', 'src', 'main', 'document-memory', 'process-worker.ts')).toContain(
      "observeChild(child, 'index-worker')",
    )
    const providers = '../packages/ai-provider/src/'
    expect(read(providers + 'codex-app-server.ts')).toContain("'codex-app-server'")
    expect(read(providers + 'agy-resident.ts')).toContain("'agy-resident'")
    expect(read(providers + 'agy-usage.ts')).toContain("'agy-usage'")
  })

  it('writes what the updater says, its error as it is, and the progress by tenths', () => {
    const updater = read('shell', 'src', 'main', 'updater.ts')
    expect(updater).toContain(
      "diagHook[/fail|error/i.test(detail) ? 'warn' : 'info']('updater', 'log'",
    )
    expect(updater).toContain("diagHook.error('updater', 'error', { phase, context, err })")
    expect(updater).toContain("diagHook.info('updater', 'progress'")
    expect(updater).toContain("diagHook.info('updater', 'available'")
  })
})
