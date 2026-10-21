import { describe, expect, it } from 'vitest'
import { deriveIndexStatus, etaText, statusSentence } from '../src/renderer/src/fork/index-status'
import { deriveIndexSummary } from '../src/renderer/src/fork/index-summary'
import { EN, VI } from '../src/renderer/src/fork/index-dashboard-i18n'
import type { HomeIndexingActivity } from '../src/shared/home-api'

function summary(over: { pending?: number; errors?: number; percent?: number; running?: boolean }) {
  return deriveIndexSummary({
    activity: {
      memory: {
        enabled: true,
        modelState: 'ready',
        pending: over.pending ?? 0,
        errors: over.errors ?? 0,
      },
      folder: over.running ? { running: true } : null,
      folderProgress: {
        totalFiles: 100,
        readyFiles: 77,
        pendingFiles: over.pending ?? 0,
        errorFiles: over.errors ?? 0,
        emptyFiles: 0,
        completedChunks: 0,
        totalChunks: 0,
        percent: over.percent ?? 77,
      },
    } as unknown as HomeIndexingActivity,
  })
}

const base = {
  switchedOff: false,
  held: false,
  modelBlocked: false,
  reading: false,
  ready: 1200,
  eta: null,
}
const num = (n: number) => n.toLocaleString('en')
const etaCopy = { etaSoon: 'soon', etaMinutes: '{n} min', etaHours: '{n} hr' }

function sentence(lang: 'en' | 'vi', input: Parameters<typeof deriveIndexStatus>[0]) {
  const d = lang === 'en' ? EN : VI
  return statusSentence(
    deriveIndexStatus(input),
    {
      working: d.status.working,
      left: d.status.left,
      paused: d.status.paused,
      ready: d.status.ready,
      why: d.why,
      resumeWhen: d.status.resumeWhen,
    },
    etaCopy,
    num,
  )
}

describe('index status sentence', () => {
  it('working: one sentence with percent and the number left while no estimate exists', () => {
    const text = sentence('en', { ...base, summary: summary({ pending: 9665 }) })
    expect(text).toBe('Getting your files ready to search · 77% · 9,665 files left')
  })

  it('working: prefers the time left once the tracker has an estimate', () => {
    const text = sentence('en', {
      ...base,
      summary: summary({ pending: 9665 }),
      eta: { unit: 'minutes', value: 12 },
    })
    expect(text).toBe('Getting your files ready to search · 77% · 12 min')
    expect(text).not.toContain('9,665')
  })

  it('paused by the person says how to resume; by the battery says when it resumes itself', () => {
    expect(sentence('en', { ...base, switchedOff: true, summary: summary({ pending: 5 }) })).toBe(
      'Paused: you paused it. Press Resume to continue.',
    )
    const battery = sentence('vi', {
      ...base,
      held: true,
      pauseReason: 'low-battery',
      summary: summary({ pending: 5 }),
    })
    expect(battery).toContain('pin yếu')
    expect(battery).toContain('cắm sạc')
  })

  it('every pause reason has a reason and a resume hint in both languages', () => {
    for (const d of [EN, VI]) {
      for (const why of Object.keys(d.status.resumeWhen)) {
        expect(d.why[why as keyof typeof d.why], why).toBeTruthy()
        expect(d.status.resumeWhen[why as keyof typeof d.status.resumeWhen], why).toBeTruthy()
      }
    }
  })

  it('a blocked search model is reported as the resource saver, not as an error', () => {
    const status = deriveIndexStatus({
      ...base,
      modelBlocked: true,
      summary: summary({ pending: 5 }),
    })
    expect(status.kind).toBe('paused')
    expect(status.why).toBe('saver')
  })

  it('ready when the queue is empty; attention tone when problems remain', () => {
    expect(sentence('en', { ...base, summary: summary({}) })).toBe('Ready to search 1,200 files')
    expect(deriveIndexStatus({ ...base, summary: summary({ errors: 3 }) }).kind).toBe('attention')
    expect(deriveIndexStatus({ ...base, summary: summary({}) }).kind).toBe('ready')
  })

  it('reading a file counts as working even with an empty queue count', () => {
    expect(deriveIndexStatus({ ...base, reading: true, summary: summary({}) }).kind).toBe('working')
  })

  it('formats seconds as the "soon" copy', () => {
    expect(etaText({ unit: 'seconds', value: 30 }, etaCopy, num)).toBe('soon')
  })
})
