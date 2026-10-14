import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Windows minimize/restore lifecycle (src/main/tab-manager.ts and
 * src/main/detached-windows.ts): the shell window and detached editor windows
 * re-fit their views after a taskbar restore, reject transient degenerate
 * client bounds, and never reload, recreate, re-activate or re-focus anything
 * along the way. Electron and the app mains are faked; the handlers the real
 * constructors register are what these tests exercise.
 */

const WINDOW_WIDTH = 800
const WINDOW_HEIGHT = 600
const TAB_STRIP_HEIGHT = 40

class FakeWindow {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  destroyed = false
  minimized = false
  shown = true
  focused = false
  bounds = { x: 0, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT }
  title = ''
  position: [number, number] = [0, 0]
  contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
  webContents = { once: vi.fn(), focus: vi.fn(), send: vi.fn() }

  on(event: string, fn: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? []
    list.push(fn)
    this.handlers.set(event, list)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(event) ?? []) fn(...args)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  isVisible(): boolean {
    return this.shown && !this.destroyed
  }
  isFocused(): boolean {
    return this.focused
  }
  getContentBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.bounds }
  }
  getPosition(): [number, number] {
    return this.position
  }
  setPosition(x: number, y: number): void {
    this.position = [x, y]
  }
  setTitle(title: string): void {
    this.title = title
  }
  getTitle(): string {
    return this.title
  }
  show(): void {
    this.shown = true
  }
  showInactive(): void {
    this.shown = true
  }
  focus(): void {
    this.focused = true
  }
  restore(): void {
    this.minimized = false
  }
  destroy(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

// detached editor windows created through the mocked BrowserWindow
const detachedWindows: FakeWindow[] = []

vi.mock('electron', () => ({
  BrowserWindow: class extends FakeWindow {
    constructor(opts: { title?: string; show?: boolean; x?: number; y?: number } = {}) {
      super()
      this.title = opts.title ?? ''
      this.shown = opts.show !== false
      this.position = [opts.x ?? 0, opts.y ?? 0]
      this.bounds = { x: 0, y: 0, width: 100, height: 100 }
      detachedWindows.push(this)
    }
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 2000, height: 1200 } }),
  },
  shell: { openExternal: vi.fn() },
  // the manual's view is constructed inline in tab-manager (createHelpView);
  // self-contained so the factory needs nothing from the module body
  WebContentsView: class {
    webContents = {
      id: 900001,
      setWindowOpenHandler: () => ({ action: 'deny' as const }),
      loadURL: () => Promise.resolve(),
      focus: () => {},
      on: () => {},
      once: () => {},
      close: () => {},
      reload: () => {},
      isDestroyed: () => false,
    }
    setBounds = () => {}
    setVisible = () => {}
  },
}))

let nextWebContentsId = 1

function makeFakeView() {
  const listeners = new Map<string, () => void>()
  return {
    webContents: {
      id: nextWebContentsId++,
      listeners,
      on: vi.fn((event: string, handler: () => void) => {
        listeners.set(event, handler)
      }),
      once: vi.fn(),
      close: vi.fn(),
      reload: vi.fn(),
      focus: vi.fn(),
      isDestroyed: vi.fn(() => false),
    },
    setVisible: vi.fn(),
    setBounds: vi.fn(),
  }
}

const createDocsView = vi.fn(() => makeFakeView())
const docsQueryDirty = vi.fn(() => Promise.resolve(false))
const markDocsNewBlank = vi.fn()
const queueDocsAiContent = vi.fn()
const requestDocsClose = vi.fn(() => Promise.resolve(true))
const setActiveDocsResolver = vi.fn()
const teardownDocsRenderer = vi.fn()

vi.mock('../../docs/src/main/docs-main', () => ({
  createDocsView: (...args: unknown[]) => createDocsView(...(args as [])),
  docsQueryDirty: (...args: unknown[]) => docsQueryDirty(...(args as [])),
  markDocsNewBlank: (...args: unknown[]) => markDocsNewBlank(...args),
  queueDocsAiContent: (...args: unknown[]) => queueDocsAiContent(...args),
  requestDocsClose: (...args: unknown[]) => requestDocsClose(...(args as [])),
  setActiveDocsResolver: (...args: unknown[]) => setActiveDocsResolver(...args),
  teardownDocsRenderer: (...args: unknown[]) => teardownDocsRenderer(...args),
}))

const createPdfView = vi.fn(() => makeFakeView())
const pdfIsDirty = vi.fn(() => false)
const clearPdfDirty = vi.fn()
const requestPdfClose = vi.fn(() => Promise.resolve(true))

vi.mock('../../pdf/src/main/pdf-main', () => ({
  createPdfView: (...args: unknown[]) => createPdfView(...(args as [])),
  pdfIsDirty: (...args: unknown[]) => pdfIsDirty(...(args as [])),
  clearPdfDirty: (...args: unknown[]) => clearPdfDirty(...args),
  requestPdfClose: (...args: unknown[]) => requestPdfClose(...(args as [])),
}))

const createSheetsView = vi.fn(() => makeFakeView())
const nudgeQueuedWorkbook = vi.fn()
const queueWorkbookForView = vi.fn()
const requestSheetsClose = vi.fn(() => Promise.resolve(true))
const setActiveSheetsWebContents = vi.fn()
const setSheetsNewBlank = vi.fn()
const sheetsPendingEditCount = vi.fn(() => 0)
const resetSheetsShuttingDown = vi.fn()

vi.mock('../../sheets/src/main/sheets-main', () => ({
  createSheetsView: (...args: unknown[]) => createSheetsView(...(args as [])),
  nudgeQueuedWorkbook: (...args: unknown[]) => nudgeQueuedWorkbook(...args),
  queueWorkbookForView: (...args: unknown[]) => queueWorkbookForView(...args),
  requestSheetsClose: (...args: unknown[]) => requestSheetsClose(...(args as [])),
  setActiveSheetsWebContents: (...args: unknown[]) => setActiveSheetsWebContents(...args),
  setSheetsNewBlank: (...args: unknown[]) => setSheetsNewBlank(...args),
  sheetsPendingEditCount: (...args: unknown[]) => sheetsPendingEditCount(...(args as [])),
  resetSheetsShuttingDown: (...args: unknown[]) => resetSheetsShuttingDown(...args),
}))

const createSlidesView = vi.fn(() => makeFakeView())
const requestSlidesClose = vi.fn(() => Promise.resolve(true))
const setActiveSlidesWebContents = vi.fn()
const slidesIsDirty = vi.fn(() => false)

vi.mock('../../slides/src/main/slides-main', () => ({
  createSlidesView: (...args: unknown[]) => createSlidesView(...(args as [])),
  requestSlidesClose: (...args: unknown[]) => requestSlidesClose(...(args as [])),
  setActiveSlidesWebContents: (...args: unknown[]) => setActiveSlidesWebContents(...args),
  slidesIsDirty: (...args: unknown[]) => slidesIsDirty(...(args as [])),
}))

const createMarkdownView = vi.fn(() => makeFakeView())
const markdownIsDirty = vi.fn(() => false)
const requestMarkdownClose = vi.fn(() => Promise.resolve(true))

vi.mock('../../markdown/src/main/markdown-main', () => ({
  createMarkdownView: (...args: unknown[]) => createMarkdownView(...(args as [])),
  markdownIsDirty: (...args: unknown[]) => markdownIsDirty(...(args as [])),
  requestMarkdownClose: (...args: unknown[]) => requestMarkdownClose(...(args as [])),
}))

const createHtmlView = vi.fn(() => makeFakeView())
const createHtmlPresentView = vi.fn(() => makeFakeView())
const htmlIsDirty = vi.fn(() => false)
const requestHtmlClose = vi.fn(() => Promise.resolve(true))

vi.mock('../../html/src/main/html-main', () => ({
  createHtmlView: (...args: unknown[]) => createHtmlView(...(args as [])),
  createHtmlPresentView: (...args: unknown[]) => createHtmlPresentView(...(args as [])),
  htmlIsDirty: (...args: unknown[]) => htmlIsDirty(...(args as [])),
  requestHtmlClose: (...args: unknown[]) => requestHtmlClose(...(args as [])),
}))

// Imported lazily so the vi.mock factories run after the fake classes above
// have been declared (vi.mock factories run at import time).
type TabManagerClass = typeof import('../src/main/tab-manager').TabManager
type DetachedModule = typeof import('../src/main/detached-windows')

let TabManager: TabManagerClass
let detached: DetachedModule

let shell: FakeWindow
let onChanged: ReturnType<typeof vi.fn>
let applyMenuFor: ReturnType<typeof vi.fn>
let manager: TabManagerClass extends never ? never : InstanceType<TabManagerClass>

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function lastCreatedView(factory: ReturnType<typeof vi.fn>) {
  return factory.mock.results.at(-1)!.value as ReturnType<typeof makeFakeView>
}

function stripRect(width: number, height: number) {
  return {
    x: 0,
    y: TAB_STRIP_HEIGHT,
    width,
    height: height - TAB_STRIP_HEIGHT,
  }
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  detachedWindows.length = 0
  nextWebContentsId = 1
  TabManager = (await import('../src/main/tab-manager')).TabManager
  detached = await import('../src/main/detached-windows')
  shell = new FakeWindow()
  onChanged = vi.fn()
  applyMenuFor = vi.fn()
  manager = new TabManager(
    shell as never,
    () => onChanged(),
    (kind) => applyMenuFor(kind),
  )
})

describe('shell window restore layout', () => {
  it('registers exactly one restore layout handler on the shell window', () => {
    expect(shell.handlers.get('restore')?.length).toBe(1)
  })

  it('re-lays out the active view synchronously and once more on the next tick', async () => {
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    view.setBounds.mockClear()

    shell.emit('restore')
    expect(view.setBounds).toHaveBeenCalledTimes(1)
    expect(view.setBounds).toHaveBeenLastCalledWith(stripRect(WINDOW_WIDTH, WINDOW_HEIGHT))

    await flush()
    expect(view.setBounds).toHaveBeenCalledTimes(2)
    expect(view.setBounds).toHaveBeenLastCalledWith(stripRect(WINDOW_WIDTH, WINDOW_HEIGHT))
  })

  it('reconciles with bounds that only settle after the restore event', async () => {
    // Windows can fire `restore` before the client rect is back: the first
    // pass must reject the transient rect, the deferred one apply the settled
    // size (issue #15 pattern, applied to restore).
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    view.setBounds.mockClear()
    shell.bounds = { x: 0, y: 0, width: 0, height: 0 }

    shell.emit('restore')
    expect(view.setBounds).not.toHaveBeenCalled()

    shell.bounds = { x: 0, y: 0, width: 1920, height: 1080 }
    await flush()
    expect(view.setBounds).toHaveBeenCalledTimes(1)
    expect(view.setBounds).toHaveBeenLastCalledWith(stripRect(1920, 1080))
  })

  it('rejects degenerate content bounds instead of zero-sizing the view', async () => {
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    view.setBounds.mockClear()
    shell.bounds = { x: 0, y: 0, width: Number.NaN, height: 0 }

    shell.emit('restore')
    await flush()
    expect(view.setBounds).not.toHaveBeenCalled()
  })

  it('a resize while minimized never leaves the active view with zero dimensions', async () => {
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    view.setBounds.mockClear()

    shell.minimized = true
    shell.bounds = { x: 0, y: 0, width: 0, height: 0 }
    shell.emit('resize')
    await flush()

    for (const call of view.setBounds.mock.calls) {
      const rect = call[0] as { width: number; height: number }
      expect(rect.width).toBeGreaterThan(0)
      expect(rect.height).toBeGreaterThan(0)
    }
  })

  it('restore on a destroyed window does nothing', async () => {
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    view.setBounds.mockClear()

    shell.destroyed = true
    shell.emit('restore')
    await flush()
    expect(view.setBounds).not.toHaveBeenCalled()
  })

  it('the deferred restore pass after the window closed does nothing', async () => {
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    view.setBounds.mockClear()

    shell.emit('restore')
    expect(view.setBounds).toHaveBeenCalledTimes(1)
    shell.destroyed = true
    await flush()
    expect(view.setBounds).toHaveBeenCalledTimes(1)
  })

  it('reconcileAfterWindowRestore is a no-op while the window is still minimized', () => {
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    view.setBounds.mockClear()
    shell.minimized = true

    manager.reconcileAfterWindowRestore()
    expect(view.setBounds).not.toHaveBeenCalled()
  })

  it('restore with Home active creates no document view and lays out nothing', () => {
    shell.emit('restore')
    expect(shell.contentView.addChildView).not.toHaveBeenCalled()
    expect(manager.list().map((t) => t.id)).toEqual(['home'])
    expect(manager.list()[0].active).toBe(true)
  })

  it('restore preserves the active document view and its webContents instance', async () => {
    const id = manager.openDocsTab('/tmp/report.docx')
    const view = lastCreatedView(createDocsView)
    shell.contentView.addChildView.mockClear()
    view.webContents.reload.mockClear()
    view.webContents.close.mockClear()

    shell.emit('restore')
    await flush()

    expect(shell.contentView.addChildView).not.toHaveBeenCalled()
    expect(view.webContents.reload).not.toHaveBeenCalled()
    expect(view.webContents.close).not.toHaveBeenCalled()
    expect(manager.list().find((t) => t.id === id)?.active).toBe(true)
    expect(manager.webContentsForTab(id)).toBe(view.webContents)
  })

  it('restore keeps inactive tabs hidden without toggling any visibility', async () => {
    manager.openDocsTab()
    const docsView = lastCreatedView(createDocsView)
    manager.openSheetsTab()
    const sheetsView = lastCreatedView(createSheetsView)
    docsView.setVisible.mockClear()
    sheetsView.setVisible.mockClear()

    shell.emit('restore')
    await flush()
    expect(docsView.setVisible).not.toHaveBeenCalled()
    expect(sheetsView.setVisible).not.toHaveBeenCalled()
  })

  it('restore does not change the active tab, fire onChanged or rebuild the menu', async () => {
    const sheetsId = manager.openSheetsTab()
    onChanged.mockClear()
    applyMenuFor.mockClear()

    shell.emit('restore')
    await flush()
    expect(manager.list().find((t) => t.id === sheetsId)?.active).toBe(true)
    expect(onChanged).not.toHaveBeenCalled()
    expect(applyMenuFor).not.toHaveBeenCalled()
  })

  it('restore does not steal keyboard focus from another window', async () => {
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    view.webContents.focus.mockClear()
    shell.webContents.focus.mockClear()

    shell.emit('restore')
    await flush()
    expect(view.webContents.focus).not.toHaveBeenCalled()
    expect(shell.webContents.focus).not.toHaveBeenCalled()
  })

  it('restore does not schedule the spare Sheets view', () => {
    vi.useFakeTimers()
    try {
      manager.openDocsTab()
      shell.emit('restore')
      vi.advanceTimersByTime(5000)
      expect(createSheetsView).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('repeated restores do not stack listeners or recreate views', async () => {
    manager.openDocsTab()
    const view = lastCreatedView(createDocsView)
    shell.contentView.addChildView.mockClear()

    for (let i = 0; i < 20; i++) shell.emit('restore')
    await flush()

    expect(shell.handlers.get('restore')?.length).toBe(1)
    expect(shell.contentView.addChildView).not.toHaveBeenCalled()
    expect(view.webContents.reload).not.toHaveBeenCalled()
  })

  it('activating a tab while the window reports degenerate bounds does not zero-size it', () => {
    // the MCP bring-forward path restores the window and activates a tab in
    // the same tick; the target view must keep its last good geometry
    const docsId = manager.openDocsTab('/tmp/report.docx')
    const docsView = lastCreatedView(createDocsView)
    manager.openSheetsTab()
    docsView.setBounds.mockClear()

    shell.bounds = { x: 0, y: 0, width: 0, height: 0 }
    manager.activateTab(docsId)
    expect(docsView.setBounds).not.toHaveBeenCalled()

    shell.bounds = { x: 0, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT }
    manager.activateTab(docsId)
    expect(docsView.setBounds).toHaveBeenLastCalledWith(stripRect(WINDOW_WIDTH, WINDOW_HEIGHT))
  })

  it('the spare Sheets view skips degenerate bounds when it spawns while minimized', () => {
    vi.useFakeTimers()
    try {
      manager.openSheetsTab()
      shell.bounds = { x: 0, y: 0, width: 0, height: 0 }
      vi.advanceTimersByTime(3000)
      const spare = lastCreatedView(createSheetsView)
      expect(spare.setBounds).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the Linux/X11 deferred resize layout unchanged', async () => {
    manager.openSheetsTab()
    const view = lastCreatedView(createSheetsView)
    view.setBounds.mockClear()

    shell.emit('resize')
    expect(view.setBounds).toHaveBeenLastCalledWith(stripRect(WINDOW_WIDTH, WINDOW_HEIGHT))

    shell.bounds = { x: 0, y: 0, width: 1920, height: 1080 }
    await flush()
    expect(view.setBounds).toHaveBeenLastCalledWith(stripRect(1920, 1080))
    expect(view.setBounds).toHaveBeenCalledTimes(2)
  })

  it('restore keeps HTML-fullscreen views covering the whole window', async () => {
    manager.openSlidesTab()
    const view = lastCreatedView(createSlidesView)
    view.webContents.listeners.get('enter-html-full-screen')!()
    view.setBounds.mockClear()
    shell.bounds = { x: 0, y: 0, width: 1920, height: 1080 }

    shell.emit('restore')
    await flush()
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it('restore keeps the content bleed over the tab strip for slides show', async () => {
    manager.openSlidesTab()
    const view = lastCreatedView(createSlidesView)
    manager.setContentBleed(view.webContents, true)
    view.setBounds.mockClear()

    shell.emit('restore')
    await flush()
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    })
  })

  it('restore updates an opening overlay bounds without reviving or fading it', async () => {
    const handles: Array<{
      setVisible: ReturnType<typeof vi.fn>
      setBounds: ReturnType<typeof vi.fn>
      fadeOut: ReturnType<typeof vi.fn>
      destroy: ReturnType<typeof vi.fn>
    }> = []
    const overlayManager = new TabManager(
      shell as never,
      () => onChanged(),
      (kind) => applyMenuFor(kind),
      undefined,
      {
        create: () => {
          const handle = {
            setVisible: vi.fn(),
            setBounds: vi.fn(),
            fadeOut: vi.fn(),
            destroy: vi.fn(),
          }
          handles.push(handle)
          return handle
        },
        now: () => 0,
        schedule: (fn: () => void, ms: number) => {
          const timer = setTimeout(fn, ms)
          return () => clearTimeout(timer)
        },
      },
    )
    overlayManager.openDocsTab('/tmp/report.docx')
    const handle = handles[0]!
    handle.setBounds.mockClear()
    handle.setVisible.mockClear()

    shell.emit('restore')
    await flush()
    expect(handle.setBounds).toHaveBeenLastCalledWith(stripRect(WINDOW_WIDTH, WINDOW_HEIGHT))
    expect(handle.setVisible).not.toHaveBeenCalled()
    expect(handle.fadeOut).not.toHaveBeenCalled()
    expect(handle.destroy).not.toHaveBeenCalled()
  })
})

describe('window lifecycle diagnostics', () => {
  it('records a compact snapshot around minimize and restore', () => {
    const lines: string[] = []
    manager.setDiagnostics((line) => lines.push(line))
    manager.openDocsTab('/tmp/report.docx')

    shell.minimized = true
    shell.emit('minimize')
    shell.minimized = false
    shell.emit('restore')

    const minimize = lines.find((line) => line.includes('[window] minimize'))
    const restore = lines.find((line) => line.includes('[window] restore'))
    expect(minimize).toContain('minimized=true')
    expect(restore).toContain('minimized=false')
    expect(restore).toContain('renderer=alive')
    expect(restore).toContain(`content=${WINDOW_WIDTH}x${WINDOW_HEIGHT}`)
    // never the document itself: no paths, no titles
    expect(restore).not.toContain('report.docx')
    expect(restore).not.toContain('/tmp')
  })

  it('records nothing for a destroyed window', () => {
    const lines: string[] = []
    manager.setDiagnostics((line) => lines.push(line))
    shell.destroyed = true
    shell.emit('restore')
    expect(lines).toHaveLength(0)
  })

  it('installs the lifecycle listeners only once', () => {
    const lines: string[] = []
    const write = (line: string) => lines.push(line)
    manager.setDiagnostics(write)
    manager.setDiagnostics(write)
    shell.emit('restore')
    const restoreSnapshots = lines.filter((line) => line.includes('[window] restore'))
    expect(restoreSnapshots).toHaveLength(1)
  })

  it('lifecycle snapshots follow the current writer and stop when diagnostics are cleared', () => {
    const lines: string[] = []
    manager.setDiagnostics((line) => lines.push(line))
    shell.emit('restore')
    expect(lines.some((line) => line.includes('[window] restore'))).toBe(true)

    manager.setDiagnostics(null)
    shell.emit('restore')
    expect(lines.filter((line) => line.includes('[window] restore'))).toHaveLength(1)
  })
})

describe('detached editor window restore layout', () => {
  function fakeDetachedView(id: number) {
    return {
      webContents: { id, isDestroyed: () => false, focus: vi.fn(), close: vi.fn() },
      setBounds: vi.fn(),
      setVisible: vi.fn(),
    }
  }

  it('re-lays out its view on restore, synchronously and on the next tick', async () => {
    const view = fakeDetachedView(41)
    detached.createDetachedEditorWindow({
      view: view as never,
      kind: 'docs',
      title: 'a.docx',
      applyMenuFor: () => {},
    })
    const win = detachedWindows[0]!
    view.setBounds.mockClear()

    win.emit('restore')
    expect(view.setBounds).toHaveBeenCalledTimes(1)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 100, height: 100 })

    await flush()
    expect(view.setBounds).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good layout while the detached window is minimized', async () => {
    const view = fakeDetachedView(42)
    detached.createDetachedEditorWindow({
      view: view as never,
      kind: 'sheets',
      title: 'b.xlsx',
      applyMenuFor: () => {},
    })
    const win = detachedWindows[0]!
    view.setBounds.mockClear()

    win.minimized = true
    win.bounds = { x: 0, y: 0, width: 0, height: 0 }
    win.emit('resize')
    await flush()

    for (const call of view.setBounds.mock.calls) {
      const rect = call[0] as { width: number; height: number }
      expect(rect.width).toBeGreaterThan(0)
      expect(rect.height).toBeGreaterThan(0)
    }
  })

  it('the deferred layout after a detached window is destroyed does nothing', async () => {
    const view = fakeDetachedView(43)
    detached.createDetachedEditorWindow({
      view: view as never,
      kind: 'pdf',
      title: 'c.pdf',
      applyMenuFor: () => {},
    })
    const win = detachedWindows[0]!
    view.setBounds.mockClear()

    win.emit('restore')
    expect(view.setBounds).toHaveBeenCalledTimes(1)
    win.destroy()
    await flush()
    expect(view.setBounds).toHaveBeenCalledTimes(1)
  })

  it('registers exactly one restore handler per detached window', () => {
    const view = fakeDetachedView(44)
    detached.createDetachedEditorWindow({
      view: view as never,
      kind: 'slides',
      title: 'd.pptx',
      applyMenuFor: () => {},
    })
    expect(detachedWindows[0]!.handlers.get('restore')?.length).toBe(1)
  })

  it('restore never detaches, recreates or closes the document view', async () => {
    const view = fakeDetachedView(45)
    detached.createDetachedEditorWindow({
      view: view as never,
      kind: 'markdown',
      title: 'e.md',
      filePath: '/tmp/e.md',
      applyMenuFor: () => {},
    })
    const win = detachedWindows[0]!

    shell.emit('restore')
    win.emit('restore')
    await flush()

    expect(win.contentView.removeChildView).not.toHaveBeenCalled()
    expect(win.contentView.addChildView).toHaveBeenCalledTimes(1)
    expect(view.webContents.close).not.toHaveBeenCalled()
    expect(detached.isDetachedTabId('detached:45')).toBe(true)
  })
})
