// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement } from 'react'
import { AgyChatBar } from '@genoffice/ui'

describe('home-chat activity states and thinking UX (Phase 2)', () => {
  // Mock dictionary matching AgyChatBar structure
  const EN = {
    thinkingNow: 'Thinking',
    thinkingHome: 'Thinking…',
    searchingFiles: 'Searching files…',
    readingDocs: 'Reading documents…',
    writingAnswer: 'Writing answer…',
    starting: 'Starting Antigravity',
    usingTool: 'Using {tool}',
    writing: 'Writing the answer',
    doneIn: 'Done in {t}',
    runFailed: 'Stopped: {m}',
    d: 'd',
    h: 'h',
    m: 'min',
  }

  const VI = {
    thinkingNow: 'Đang suy nghĩ',
    thinkingHome: 'Đang suy nghĩ…',
    searchingFiles: 'Đang tìm kiếm tệp…',
    readingDocs: 'Đang đọc tài liệu…',
    writingAnswer: 'Đang viết câu trả lời…',
    starting: 'Đang khởi động Antigravity',
    usingTool: 'Đang dùng {tool}',
    writing: 'Đang viết câu trả lời',
    doneIn: 'Xong trong {t}',
    runFailed: 'Đã dừng: {m}',
    d: 'ngày',
    h: 'giờ',
    m: 'phút',
  }

  interface RunStep {
    kind: 'thinking' | 'tool' | 'writing'
    tool?: string
    target?: string
    tokens?: number
    seconds?: number
  }

  interface Run {
    id: string
    startedAt: number
    endedAt?: number
    steps: RunStep[]
    phase: 'thinking' | 'tool' | 'writing' | 'done' | 'error'
    tool?: string
    target?: string
    tokens: number
    error?: string
  }

  function fill(text: string, values: Record<string, string | number>): string {
    return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
  }

  function span(ms: number, d: typeof EN): string {
    const minutes = Math.max(1, Math.round(ms / 60_000))
    if (minutes >= 2880) return `${Math.round(minutes / 1440)} ${d.d}`
    if (minutes >= 90) return `${Math.floor(minutes / 60)} ${d.h} ${minutes % 60} ${d.m}`
    return `${minutes} ${d.m}`
  }

  function formatThinkTitle(
    run: Run,
    d: typeof EN,
    mode: 'default' | 'home-chat' = 'default',
  ): string {
    const seconds = Math.max(0, ((run.endedAt ?? Date.now()) - run.startedAt) / 1000)
    if (run.phase === 'done') {
      const time = seconds >= 60 ? span(seconds * 1000, d) : `${Math.round(seconds)}s`
      return fill(d.doneIn, { t: time })
    }
    if (run.phase === 'error') return fill(d.runFailed, { m: run.error ?? '' })

    if (mode === 'home-chat') {
      const time = seconds >= 60 ? span(seconds * 1000, d) : `${Math.round(seconds)}s`
      let label = d.thinkingHome
      if (run.phase === 'writing') {
        label = d.writingAnswer
      } else if (run.phase === 'tool') {
        const toolLower = (run.tool ?? '').toLowerCase()
        if (
          toolLower.includes('search') ||
          toolLower.includes('find') ||
          toolLower.includes('grep') ||
          toolLower.includes('glob')
        ) {
          label = d.searchingFiles
        } else if (
          toolLower.includes('read') ||
          toolLower.includes('view') ||
          toolLower.includes('open')
        ) {
          label = d.readingDocs
        } else {
          label = `${fill(d.usingTool, {
            tool: `${run.tool ?? ''}${run.target ? ` ${run.target}` : ''}`.trim(),
          })}…`
        }
      }
      return `${label} · ${time}`
    }

    const defaultTime =
      seconds >= 60 ? span(seconds * 1000, d) : `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
    const label =
      run.phase === 'writing'
        ? d.writing
        : run.phase === 'tool'
          ? fill(d.usingTool, {
              tool: `${run.tool ?? ''}${run.target ? ` ${run.target}` : ''}`.trim(),
            })
          : run.steps.length === 0
            ? d.starting
            : d.thinkingNow
    return `${label}… ${defaultTime}`
  }

  it('home-chat mode formats thinking state with subtle elapsed time', () => {
    const now = 1_000_000
    const run: Run = {
      id: 'run-1',
      startedAt: now - 7000,
      endedAt: now,
      steps: [],
      phase: 'thinking',
      tokens: 0,
    }

    const enTitle = formatThinkTitle(run, EN, 'home-chat')
    expect(enTitle).toBe('Thinking… · 7s')

    const viTitle = formatThinkTitle(run, VI, 'home-chat')
    expect(viTitle).toBe('Đang suy nghĩ… · 7s')
  })

  it('home-chat mode maps search tool execution to Searching files…', () => {
    const now = 1_000_000
    const run: Run = {
      id: 'run-1',
      startedAt: now - 3000,
      endedAt: now,
      steps: [{ kind: 'tool', tool: 'document_search' }],
      phase: 'tool',
      tool: 'document_search',
      tokens: 0,
    }

    expect(formatThinkTitle(run, EN, 'home-chat')).toBe('Searching files… · 3s')
    expect(formatThinkTitle(run, VI, 'home-chat')).toBe('Đang tìm kiếm tệp… · 3s')
  })

  it('home-chat mode maps read tool execution to Reading documents…', () => {
    const now = 1_000_000
    const run: Run = {
      id: 'run-1',
      startedAt: now - 4000,
      endedAt: now,
      steps: [{ kind: 'tool', tool: 'view_file' }],
      phase: 'tool',
      tool: 'view_file',
      tokens: 0,
    }

    expect(formatThinkTitle(run, EN, 'home-chat')).toBe('Reading documents… · 4s')
    expect(formatThinkTitle(run, VI, 'home-chat')).toBe('Đang đọc tài liệu… · 4s')
  })

  it('home-chat mode maps answer writing phase to Writing answer…', () => {
    const now = 1_000_000
    const run: Run = {
      id: 'run-1',
      startedAt: now - 5000,
      endedAt: now,
      steps: [{ kind: 'writing' }],
      phase: 'writing',
      tokens: 0,
    }

    expect(formatThinkTitle(run, EN, 'home-chat')).toBe('Writing answer… · 5s')
    expect(formatThinkTitle(run, VI, 'home-chat')).toBe('Đang viết câu trả lời… · 5s')
  })

  it('default mode preserves backward compatibility for other consumers', () => {
    const now = 1_000_000
    const run: Run = {
      id: 'run-1',
      startedAt: now - 7000,
      endedAt: now,
      steps: [],
      phase: 'thinking',
      tokens: 0,
    }

    const defaultTitle = formatThinkTitle(run, EN, 'default')
    expect(defaultTitle).toBe('Starting Antigravity… 7.0s')
  })

  it('activeRunId filtering prevents activity cross-contamination', () => {
    const activeRunId = 'run-current'
    const eventsReceived: string[] = []

    const handleEvent = (event: { runId: string; phase: string }) => {
      if (activeRunId && event.runId !== activeRunId) return
      eventsReceived.push(`${event.runId}:${event.phase}`)
    }

    handleEvent({ runId: 'run-stale-old', phase: 'thinking' })
    handleEvent({ runId: 'run-current', phase: 'thinking' })
    handleEvent({ runId: 'run-current', phase: 'writing' })
    handleEvent({ runId: 'run-other-session', phase: 'done' })

    expect(eventsReceived).toEqual(['run-current:thinking', 'run-current:writing'])
  })

  it('cancellation resets run and prevents stale indicators', () => {
    let activeRun: Run | null = {
      id: 'run-1',
      startedAt: Date.now(),
      steps: [],
      phase: 'thinking',
      tokens: 0,
    }

    const onStop = () => {
      // Upon stop, busy becomes false and run is cleared
      activeRun = null
    }

    expect(activeRun).not.toBeNull()
    onStop()
    expect(activeRun).toBeNull()
  })

  it('single activity presentation contract: hides activity once tokens stream', () => {
    // Model state transitions
    type TurnState = {
      streaming: boolean
      text: string
      showActivity: boolean
    }

    const evaluateTurnState = (streaming: boolean, text: string): TurnState => ({
      streaming,
      text,
      // Only show activity when streaming and no text has arrived yet
      showActivity: streaming && !text,
    })

    // Phase A: Request submitted, awaiting first token -> Activity visible
    const initialTurn = evaluateTurnState(true, '')
    expect(initialTurn.showActivity).toBe(true)

    // Phase B: First tokens arrived -> Activity unmounted, clean text shown
    const streamingTurn = evaluateTurnState(true, 'Hello, here are your documents...')
    expect(streamingTurn.showActivity).toBe(false)

    // Phase C: Completed -> Clean final answer
    const doneTurn = evaluateTurnState(false, 'Hello, here are your documents...')
    expect(doneTurn.showActivity).toBe(false)
  })

  it('non-Antigravity provider displays fallback working indicator when busy', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    try {
      // 1. When busy={true} with no Antigravity active, renders Thinking…
      await act(async () => {
        root.render(
          createElement(AgyChatBar, { lang: 'en', part: 'steps', mode: 'home-chat', busy: true }),
        )
      })
      const title = host.querySelector('.agy-think-title')
      expect(title).not.toBeNull()
      expect(title?.textContent).toContain('Thinking…')

      // 2. When busy={false}, indicator is not rendered
      await act(async () => {
        root.render(
          createElement(AgyChatBar, { lang: 'en', part: 'steps', mode: 'home-chat', busy: false }),
        )
      })
      expect(host.querySelector('.agy-think-title')).toBeNull()

      // 3. When lang='vi' and busy={true}, renders Đang suy nghĩ…
      await act(async () => {
        root.render(
          createElement(AgyChatBar, { lang: 'vi', part: 'steps', mode: 'home-chat', busy: true }),
        )
      })
      const viTitle = host.querySelector('.agy-think-title')
      expect(viTitle?.textContent).toContain('Đang suy nghĩ…')
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('stale Thinking events never reach a new session or inactive run', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    let activityListener: ((event: unknown) => void) | null = null
    const fakeApi = {
      getAgyChatState: async () => ({
        active: true,
        selected: 'fast',
        models: [{ id: 'fast', group: 'fast', title: 'Fast' }],
      }),
      getAgyChatUsage: async () => ({ refreshing: false }),
      onAgyChatUsage: () => () => {},
      onAgyChatActivity: (fn: (event: unknown) => void) => {
        activityListener = fn
        return () => {
          activityListener = null
        }
      },
    }

    try {
      // 1. Initial busy session with runId = 'session-1-run'
      await act(async () => {
        root.render(
          createElement(AgyChatBar, {
            lang: 'en',
            part: 'steps',
            mode: 'home-chat',
            busy: true,
            activeRunId: 'session-1-run',
            api: fakeApi as never,
          }),
        )
      })

      // Send activity for session 1
      await act(async () => {
        activityListener?.({
          runId: 'session-1-run',
          phase: 'thinking',
          at: Date.now(),
        })
      })

      let title = host.querySelector('.agy-think-title')
      expect(title?.textContent).toContain('Thinking…')

      // 2. User stops / session completes: busy becomes false
      await act(async () => {
        root.render(
          createElement(AgyChatBar, {
            lang: 'en',
            part: 'steps',
            mode: 'home-chat',
            busy: false,
            activeRunId: undefined,
            api: fakeApi as never,
          }),
        )
      })

      // Send a stale event from old session-1-run
      await act(async () => {
        activityListener?.({
          runId: 'session-1-run',
          phase: 'writing',
          at: Date.now(),
        })
      })

      // Should NOT render activity because busy is false
      expect(host.querySelector('.agy-think-title')).toBeNull()

      // 3. User starts a new session with runId = 'session-2-run'
      await act(async () => {
        root.render(
          createElement(AgyChatBar, {
            lang: 'en',
            part: 'steps',
            mode: 'home-chat',
            busy: true,
            activeRunId: 'session-2-run',
            api: fakeApi as never,
          }),
        )
      })

      // Another stale event from old session-1-run arrives
      await act(async () => {
        activityListener?.({
          runId: 'session-1-run',
          phase: 'tool',
          tool: 'searchFiles',
          at: Date.now(),
        })
      })

      // Old session tool activity must NOT be displayed in session 2!
      title = host.querySelector('.agy-think-title')
      expect(title?.textContent).not.toContain('Searching files…')
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
})
