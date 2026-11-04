import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RelaunchRequests,
  describeWindows,
  hideWindowsForQuit,
  runQuitSequence,
  type QuitStep,
} from '../src/main/quit-sequence'

function logSink() {
  const entries: Array<{ level: string; ev: string; data: any }> = []
  return {
    entries,
    log: {
      info: (_c: string, ev: string, data?: unknown) =>
        void entries.push({ level: 'info', ev, data }),
      warn: (_c: string, ev: string, data?: unknown) =>
        void entries.push({ level: 'warn', ev, data }),
    },
  }
}

describe('hiding the windows for quit', () => {
  it('hides every window that is still there, and counts them', () => {
    const calls: string[] = []
    const win = (name: string, destroyed = false) => ({
      isDestroyed: () => destroyed,
      hide: () => void calls.push(name),
    })
    expect(hideWindowsForQuit([win('a'), win('gone', true), win('b')])).toBe(2)
    expect(calls).toEqual(['a', 'b'])
  })

  it('does not stop at a window that throws', () => {
    const calls: string[] = []
    const bad = {
      isDestroyed: () => false,
      hide: () => {
        throw new Error('already closing')
      },
    }
    const good = { isDestroyed: () => false, hide: () => void calls.push('good') }
    expect(hideWindowsForQuit([bad, good])).toBe(1)
    expect(calls).toEqual(['good'])
  })
})

describe('the quit sequence', () => {
  it('runs the steps in order and logs the name and time of each, nothing else', async () => {
    const { entries, log } = logSink()
    const ran: string[] = []
    let t = 0
    const steps: QuitStep[] = [
      { name: 'one', run: () => void (ran.push('one'), (t += 30)) },
      {
        name: 'two',
        run: async () => {
          await Promise.resolve()
          ran.push('two')
          t += 120
        },
      },
    ]
    const result = await runQuitSequence(steps, { log, forceExit: () => undefined, now: () => t })
    expect(ran).toEqual(['one', 'two'])
    expect(entries.map((e) => [e.ev, e.data.name, e.data.ms])).toEqual([
      ['step', 'one', 30],
      ['step', 'two', 120],
      ['done', undefined, 150],
    ])
    expect(result).toMatchObject({ totalMs: 150, skipped: [], failed: [] })
  })

  it('a step that throws is logged and the next one still runs', async () => {
    const { entries, log } = logSink()
    const ran: string[] = []
    const result = await runQuitSequence(
      [
        {
          name: 'broken',
          run: () => {
            throw new Error('db is locked')
          },
        },
        { name: 'after', run: () => void ran.push('after') },
      ],
      { log, forceExit: () => undefined },
    )
    expect(ran).toEqual(['after'])
    expect(result.failed).toEqual(['broken'])
    expect(entries.find((e) => e.ev === 'step.failed')?.data.name).toBe('broken')
  })

  it('skips the steps that remain once the deadline has passed, and says which', async () => {
    const { entries, log } = logSink()
    let t = 0
    const ran: string[] = []
    const result = await runQuitSequence(
      [
        { name: 'slow', run: () => void (ran.push('slow'), (t += 30_000)) }, // one long synchronous call
        { name: 'late-1', run: () => void ran.push('late-1') },
        { name: 'late-2', run: () => void ran.push('late-2') },
      ],
      { log, forceExit: () => undefined, now: () => t, deadlineMs: 25_000 },
    )
    expect(ran).toEqual(['slow'])
    expect(result.skipped).toEqual(['late-1', 'late-2'])
    expect(entries.find((e) => e.ev === 'skipped')?.data.names).toEqual(['late-1', 'late-2'])
  })

  it('ends the process when the deadline passes while a step is still waiting', async () => {
    const { entries, log } = logSink()
    let exited = 0
    const timers: Array<() => void> = []
    const result = runQuitSequence(
      [{ name: 'stuck', run: () => new Promise<void>(() => undefined) }],
      {
        log,
        forceExit: () => void exited++,
        setTimeout: ((fn: () => void) => (timers.push(fn), 1)) as any,
        clearTimeout: (() => undefined) as any,
        deadlineMs: 25_000,
      },
    )
    void result
    await Promise.resolve()
    expect(exited).toBe(0)
    timers[0]!() // the clock reaches the deadline
    expect(exited).toBe(1)
    expect(entries.map((e) => e.ev)).toContain('deadline')
  })

  it('clears its timer when the steps finish', async () => {
    const { log } = logSink()
    let cleared = 0
    await runQuitSequence([{ name: 'a', run: () => undefined }], {
      log,
      forceExit: () => undefined,
      setTimeout: (() => 7) as any,
      clearTimeout: (() => void cleared++) as any,
    })
    expect(cleared).toBe(1)
  })
})

describe('how the quit is wired', () => {
  const root = join(__dirname, '..', '..')
  const index = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')

  it('hides the windows when the quit is confirmed, before the clean-up runs', () => {
    const confirmed = index.indexOf('if (quitCoordinator.isConfirmed()) {')
    const hide = index.indexOf('hideWindowsForQuit(BrowserWindow.getAllWindows())', confirmed)
    const stopSheets = index.indexOf('stopSheetsSidecar()', confirmed)
    expect(hide).toBeGreaterThan(confirmed)
    expect(hide).toBeLessThan(stopSheets)
    const willQuit = index.indexOf("app.on('will-quit'")
    expect(index.indexOf('hideWindowsForQuit', willQuit)).toBeLessThan(
      index.indexOf('runQuitSequence(', willQuit),
    )
  })

  it('shuts the AI helpers down only when the app really quits, not when the save prompt is cancelled', () => {
    const docs = readFileSync(join(root, 'docs', 'src', 'main', 'docs-main.ts'), 'utf8')
    const at = docs.indexOf('shutdownAgyResidentServers()\n  })')
    const block = docs.slice(Math.max(0, at - 200), at)
    expect(block).toContain("app.once('will-quit'")
    expect(block).not.toContain("app.once('before-quit'")
  })

  it('no helper is shut down at the first before-quit (it also fires when the save prompt is cancelled)', () => {
    for (const [file, marker] of [
      [join(root, 'sheets', 'src', 'main', 'sheets-main.ts'), 'shutdownCodexAppServers)'],
      [join(root, 'slides', 'src', 'main', 'ai-ipc.ts'), 'shutdownCodexAppServers)'],
      [join(__dirname, '..', 'src', 'main', 'fork', 'clipboard-history-ipc.ts'), 'store.dispose()'],
    ] as const) {
      const source = readFileSync(file, 'utf8')
      const at = source.indexOf(marker)
      expect(at, file).toBeGreaterThan(-1)
      const line = source.slice(source.lastIndexOf('\n', at) + 1, at + marker.length)
      expect(line, file).toContain("app.once('will-quit'")
    }
  })

  it('keeps the request to start again out of reach of a window being revived, and makes it on both ways out', () => {
    const handler = index.slice(index.indexOf("app.on('second-instance'"))
    const body = handler.slice(0, handler.indexOf('openLaunchPaths(paths)'))
    expect(body).toContain('appShuttingDown')
    expect(body).toContain('relaunchRequests.add(argv)')
    // the normal end of the clean-up and the forced one both start the app again
    expect(index.match(/app\.relaunch\(\{ args: relaunchRequests\.toArgs\(\) \}\)/g)).toHaveLength(
      2,
    )
  })

  it('marks the databases and lists as essential steps, and the document index closes before the file index', () => {
    const steps = index.slice(
      index.indexOf('const steps: QuitStep[]'),
      index.indexOf('void runQuitSequence('),
    )
    for (const name of [
      'folder-scan-close',
      'known-sources-close',
      'document-memory-close',
      'file-index-store-close',
    ]) {
      const at = steps.indexOf(`'${name}'`)
      expect(at, name).toBeGreaterThan(-1)
      expect(steps.slice(at, at + 80), name).toContain('essential: true')
    }
    expect(steps.indexOf("'document-memory-close'")).toBeLessThan(
      steps.indexOf("'file-index-store-close'"),
    )
  })
})

describe('essential steps', () => {
  it('are not skipped when the deadline has passed, optional ones are', async () => {
    const { log } = logSink()
    let t = 0
    const ran: string[] = []
    const result = await runQuitSequence(
      [
        { name: 'slow', essential: true, run: () => void (ran.push('slow'), (t += 30_000)) },
        { name: 'database', essential: true, run: () => void ran.push('database') },
        { name: 'tidy', run: () => void ran.push('tidy') },
      ],
      { log, forceExit: () => undefined, now: () => t, deadlineMs: 25_000 },
    )
    expect(ran).toEqual(['slow', 'database'])
    expect(result.skipped).toEqual(['tidy'])
  })

  it('hold the process back at the first deadline and let go at the hard one', async () => {
    const { entries, log } = logSink()
    let exited = 0
    let t = 0
    const timers: Array<{ fn: () => void; ms: number }> = []
    void runQuitSequence(
      [{ name: 'closing', essential: true, run: () => new Promise<void>(() => undefined) }],
      {
        log,
        forceExit: () => void exited++,
        now: () => t,
        setTimeout: ((fn: () => void, ms: number) => (
          timers.push({ fn, ms }),
          timers.length
        )) as any,
        clearTimeout: (() => undefined) as any,
        deadlineMs: 25_000,
        hardDeadlineMs: 60_000,
      },
    )
    await Promise.resolve()
    t = 25_000
    timers[0]!.fn() // the first deadline: a database is closing, so the process is let alone
    expect(exited).toBe(0)
    expect(timers[1]!.ms).toBe(35_000)
    t = 60_000
    timers[1]!.fn() // the hard one
    expect(exited).toBe(1)
    expect(entries.map((e) => e.ev)).toEqual(['deadline.waiting', 'deadline'])
  })

  it('end the process at the first deadline when only an optional step is waiting', async () => {
    const { log } = logSink()
    let exited = 0
    const timers: Array<() => void> = []
    void runQuitSequence([{ name: 'tidy', run: () => new Promise<void>(() => undefined) }], {
      log,
      forceExit: () => void exited++,
      setTimeout: ((fn: () => void) => (timers.push(fn), 1)) as any,
      clearTimeout: (() => undefined) as any,
    })
    await Promise.resolve()
    timers[0]!()
    expect(exited).toBe(1)
  })
})

describe('starting the app again after a quit', () => {
  it('keeps every file asked for, once, from every second copy', () => {
    const requests = new RelaunchRequests()
    expect(requests.isRequested).toBe(false)
    requests.add(['GenOffice.exe', 'C:\\docs\\a.docx'])
    requests.add(['GenOffice.exe', 'C:\\docs\\b.xlsx', 'C:\\docs\\a.docx'])
    expect(requests.isRequested).toBe(true)
    expect(requests.toArgs()).toEqual(['C:\\docs\\a.docx', 'C:\\docs\\b.xlsx'])
  })

  it('a copy started without arguments still asks for a start', () => {
    const requests = new RelaunchRequests()
    requests.add(['GenOffice.exe'])
    expect(requests.isRequested).toBe(true)
    expect(requests.toArgs()).toEqual([])
  })
})

describe('describing the windows for the log', () => {
  it('counts the windows that exist and those that can be seen', () => {
    const win = (visible: boolean, destroyed = false) => ({
      isDestroyed: () => destroyed,
      hide: () => undefined,
      isVisible: () => visible,
    })
    expect(describeWindows([win(true), win(false), win(true, true)])).toEqual({
      count: 2,
      visible: 1,
    })
    expect(describeWindows([])).toEqual({ count: 0, visible: 0 })
  })
})
