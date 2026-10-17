import { beforeEach, describe, expect, it, vi } from 'vitest'

const appQuit = vi.fn()
const markSheetsShuttingDown = vi.fn()
const resetSheetsShuttingDown = vi.fn()
const setInteractiveQuitCoordination = vi.fn()
const requestSheetsClose = vi.fn()

vi.mock('electron', () => ({
  app: {
    quit: (...args: unknown[]) => appQuit(...args),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
}))

vi.mock('../../sheets/src/main/sheets-main', () => ({
  markSheetsShuttingDown: (...args: unknown[]) => markSheetsShuttingDown(...args),
  resetSheetsShuttingDown: (...args: unknown[]) => resetSheetsShuttingDown(...args),
  setInteractiveQuitCoordination: (...args: unknown[]) => setInteractiveQuitCoordination(...args),
  requestSheetsClose: (...args: unknown[]) => requestSheetsClose(...args),
}))

vi.mock('../../docs/src/main/docs-main', () => ({
  docsQueryDirty: vi.fn(() => Promise.resolve(false)),
  requestDocsClose: vi.fn(() => Promise.resolve(true)),
}))

describe('QuitCoordinator — Lifecycle & Shutdown State Machine', () => {
  let QuitCoordinator: typeof import('../src/main/quit-coordinator').QuitCoordinator

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../src/main/quit-coordinator')
    QuitCoordinator = mod.QuitCoordinator
  })

  it('initializes with idle state and registers interactive quit coordination', () => {
    const coordinator = new QuitCoordinator()
    expect(setInteractiveQuitCoordination).toHaveBeenCalledWith(true)
    expect(coordinator.isQuitting()).toBe(false)
    expect(coordinator.isConfirmed()).toBe(false)
    expect(coordinator.isPromptInFlight()).toBe(false)
  })

  it('tracks quitInProgress and promptInFlight state transitions', () => {
    const coordinator = new QuitCoordinator()
    coordinator.setQuitInProgress(true)
    coordinator.setPromptInFlight(true)

    expect(coordinator.isQuitting()).toBe(true)
    expect(coordinator.isPromptInFlight()).toBe(true)
    expect(coordinator.isConfirmed()).toBe(false)
  })

  it('confirmQuit marks confirmed, clears in-flight prompt, latches sheets shutdown, and calls app.quit', () => {
    const coordinator = new QuitCoordinator()
    coordinator.setQuitInProgress(true)
    coordinator.setPromptInFlight(true)

    coordinator.confirmQuit()

    expect(coordinator.isConfirmed()).toBe(true)
    expect(coordinator.isPromptInFlight()).toBe(false)
    expect(markSheetsShuttingDown).toHaveBeenCalledTimes(1)
    expect(appQuit).toHaveBeenCalledTimes(1)
  })

  it('abortQuit resets all state flags and resets sheets shutdown latch', () => {
    const coordinator = new QuitCoordinator()
    coordinator.setQuitInProgress(true)
    coordinator.setPromptInFlight(true)

    coordinator.abortQuit()

    expect(coordinator.isQuitting()).toBe(false)
    expect(coordinator.isConfirmed()).toBe(false)
    expect(coordinator.isPromptInFlight()).toBe(false)
    expect(resetSheetsShuttingDown).toHaveBeenCalledTimes(1)
    expect(appQuit).not.toHaveBeenCalled()
  })

  it('exercises coordinateQuit: user cancels detached window prompt, aborting quit', async () => {
    const coordinator = new QuitCoordinator()
    const promptDetached = vi.fn().mockResolvedValue(false)
    const promptShell = vi.fn().mockResolvedValue(true)

    const result = await coordinator.coordinateQuit(promptDetached, promptShell)

    expect(result).toBe(false)
    expect(coordinator.isQuitting()).toBe(false)
    expect(coordinator.isConfirmed()).toBe(false)
    expect(promptDetached).toHaveBeenCalledTimes(1)
    expect(promptShell).not.toHaveBeenCalled()
    expect(resetSheetsShuttingDown).toHaveBeenCalled()
    expect(appQuit).not.toHaveBeenCalled()
  })

  it('exercises coordinateQuit: user cancels shell window prompt, aborting quit', async () => {
    const coordinator = new QuitCoordinator()
    const promptDetached = vi.fn().mockResolvedValue(true)
    const promptShell = vi.fn().mockResolvedValue(false)

    const result = await coordinator.coordinateQuit(promptDetached, promptShell)

    expect(result).toBe(false)
    expect(coordinator.isQuitting()).toBe(false)
    expect(coordinator.isConfirmed()).toBe(false)
    expect(promptDetached).toHaveBeenCalledTimes(1)
    expect(promptShell).toHaveBeenCalledTimes(1)
    expect(resetSheetsShuttingDown).toHaveBeenCalled()
    expect(appQuit).not.toHaveBeenCalled()
  })

  it('exercises coordinateQuit: user saves or discards all dirty windows, confirming quit', async () => {
    const coordinator = new QuitCoordinator()
    const promptDetached = vi.fn().mockResolvedValue(true)
    const promptShell = vi.fn().mockResolvedValue(true)

    const result = await coordinator.coordinateQuit(promptDetached, promptShell)

    expect(result).toBe(true)
    expect(coordinator.isConfirmed()).toBe(true)
    expect(markSheetsShuttingDown).toHaveBeenCalled()
    expect(appQuit).toHaveBeenCalledTimes(1)
  })

  it('exercises coordinateQuit: debounces concurrent quit requests while prompt is in flight', async () => {
    const coordinator = new QuitCoordinator()
    let resolvePrompt: (val: boolean) => void = () => {}
    const slowPrompt = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePrompt = resolve
        }),
    )
    const promptShell = vi.fn().mockResolvedValue(true)

    const firstRunPromise = coordinator.coordinateQuit(slowPrompt, promptShell)
    expect(coordinator.isPromptInFlight()).toBe(true)

    // Second concurrent call while promptInFlight is true
    const secondResult = await coordinator.coordinateQuit(slowPrompt, promptShell)
    expect(secondResult).toBe(false)

    resolvePrompt(true)
    const firstResult = await firstRunPromise
    expect(firstResult).toBe(true)
    expect(coordinator.isConfirmed()).toBe(true)
    expect(appQuit).toHaveBeenCalledTimes(1)
  })

  it('exercises coordinateQuit: aborts quit safely when prompt throws an unhandled rejection', async () => {
    const coordinator = new QuitCoordinator()
    const failingPrompt = vi.fn().mockRejectedValue(new Error('RPC disconnected'))
    const promptShell = vi.fn().mockResolvedValue(true)

    await expect(coordinator.coordinateQuit(failingPrompt, promptShell)).rejects.toThrow(
      'RPC disconnected',
    )

    expect(coordinator.isQuitting()).toBe(false)
    expect(coordinator.isConfirmed()).toBe(false)
    expect(coordinator.isPromptInFlight()).toBe(false)
    expect(resetSheetsShuttingDown).toHaveBeenCalled()
    expect(appQuit).not.toHaveBeenCalled()
  })

  it('verifies dirtySheetsTabs triggers requestSheetsClose during quit prompt walk', async () => {
    const coordinator = new QuitCoordinator()
    requestSheetsClose.mockResolvedValue(true)

    // A sheets tab dirty from either in-memory pending edits or an autosaved recovery file
    const sheetsTab = { id: 'sheets-tab-1', webContents: { id: 42 } }
    const fakeWin = { isDestroyed: () => false }

    const fakeManager = {
      dirtySheetsTabs: () => [sheetsTab],
      dirtyPdfTabs: () => [],
      dirtyMarkdownTabs: () => [],
      dirtyHtmlTabs: () => [],
      dirtySlidesTabs: () => [],
      docsTabs: () => [],
      activateTab: vi.fn(),
    }

    const { promptDirtyTabs } = await import('../src/main/window-close-guard')
    const promptResult = await promptDirtyTabs(fakeWin as never, fakeManager as never)

    expect(promptResult).toBe(true)
    expect(fakeManager.activateTab).toHaveBeenCalledWith('sheets-tab-1')
    expect(requestSheetsClose).toHaveBeenCalledWith(sheetsTab.webContents, fakeWin)

    // Confirm that coordinateQuit succeeds when promptDirtyTabs succeeds
    const quitResult = await coordinator.coordinateQuit(
      () => Promise.resolve(true),
      () => promptDirtyTabs(fakeWin as never, fakeManager as never),
    )
    expect(quitResult).toBe(true)
    expect(coordinator.isConfirmed()).toBe(true)
    expect(appQuit).toHaveBeenCalled()
  })
})
