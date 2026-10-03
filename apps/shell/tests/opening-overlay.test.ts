import { describe, expect, it } from 'vitest'
import {
  OpeningOverlays,
  type OverlayDeps,
  type OverlayHandle,
} from '../src/main/fork/opening-overlay'

function rig() {
  let now = 0
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
  const log: string[] = []
  const handles: OverlayHandle[] = []
  const deps: OverlayDeps = {
    create: (spec) => {
      log.push(`create ${spec.fileName}`)
      const handle: OverlayHandle = {
        setVisible: (v) => void log.push(`visible ${v}`),
        setBounds: (b) => void log.push(`bounds ${b.height}`),
        fadeOut: () => void log.push('fade'),
        destroy: () => void log.push('destroy'),
      }
      handles.push(handle)
      return handle
    },
    now: () => now,
    schedule: (fn, ms) => {
      const timer = { at: now + ms, fn, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    },
  }
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      now = due.at
      due.live = false
      due.fn()
    }
    now = target
  }
  const overlays = new OpeningOverlays(deps, { minShowMs: 900, fadeMs: 350, maxWaitMs: 15_000 })
  return { overlays, log, advance }
}

const spec = { fileName: 'a.xlsx', app: 'sheets' as const }

describe('the opening overlay over a tab', () => {
  it('stays until the document is ready, then fades and goes', () => {
    const { overlays, log, advance } = rig()
    overlays.begin('t1', spec)
    advance(3000)
    expect(log).toEqual(['create a.xlsx'])
    overlays.ready('t1')
    advance(0)
    expect(log).toEqual(['create a.xlsx', 'fade'])
    advance(350)
    expect(log).toEqual(['create a.xlsx', 'fade', 'destroy'])
    expect(overlays.has('t1')).toBe(false)
  })

  it('shows a document that is ready at once for a short while, not a flash', () => {
    const { overlays, log, advance } = rig()
    overlays.begin('t1', spec)
    advance(100)
    overlays.ready('t1')
    advance(799)
    expect(log).not.toContain('fade')
    advance(1)
    expect(log).toContain('fade')
  })

  it('never holds a tab for ever when the document says nothing', () => {
    const { overlays, log, advance } = rig()
    overlays.begin('t1', spec)
    advance(14_999)
    expect(log).not.toContain('fade')
    advance(1)
    expect(log).toContain('fade')
    advance(350)
    expect(log).toContain('destroy')
  })

  it('shows only the overlay of the tab in front', () => {
    const { overlays, log } = rig()
    overlays.begin('t1', spec)
    overlays.begin('t2', { fileName: 'b.docx', app: 'docs' })
    overlays.activate('t2')
    expect(log.slice(-2)).toEqual(['visible false', 'visible true'])
  })

  it('follows the tab content when the window is resized, for the active tab only', () => {
    const { overlays, log } = rig()
    overlays.begin('t1', spec)
    overlays.begin('t2', spec)
    overlays.layout('t2', { x: 0, y: 40, width: 800, height: 560 })
    expect(log.filter((l) => l.startsWith('bounds'))).toEqual(['bounds 560'])
  })

  it('takes the overlay away without a fade when its tab goes, and ignores a late ready', () => {
    const { overlays, log, advance } = rig()
    overlays.begin('t1', spec)
    overlays.drop('t1')
    overlays.ready('t1')
    advance(30_000)
    expect(log).toEqual(['create a.xlsx', 'destroy'])
  })

  it('ignores a second ready while already fading, and a tab that has no overlay', () => {
    const { overlays, log, advance } = rig()
    overlays.begin('t1', spec)
    overlays.ready('t1')
    advance(900)
    overlays.ready('t1')
    overlays.ready('nope')
    advance(5000)
    expect(log.filter((l) => l === 'fade')).toHaveLength(1)
    expect(log.filter((l) => l === 'destroy')).toHaveLength(1)
  })
})
