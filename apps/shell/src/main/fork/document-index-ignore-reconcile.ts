import type { IpcMain } from 'electron'
import { resolve } from 'node:path'
import type { FolderScanManager } from '../document-memory/folder-scan'
import {
  getIgnorePolicyGeneration,
  isPathCaseInsensitive,
  registerIgnoreIpcHandlers,
  subscribeIgnorePolicyChanges,
  type IgnorePolicyChangeEvent,
} from '../document-memory/ignore-policy'

export interface IgnoreReconcileDeps {
  ipcMain?: Pick<IpcMain, 'handle'>
  getFolderScan: () =>
    | (Pick<FolderScanManager, 'folders' | 'reconcile'> &
        Partial<Pick<FolderScanManager, 'onRootsChanged' | 'status'>>)
    | null
  onRefreshFileIndex?: (roots: string[]) => void
  invalidateFolderCounts?: () => void
  debounceMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  maxRetries?: number
}

export interface IgnoreReconcileController {
  schedule: (event?: Partial<IgnorePolicyChangeEvent>) => void
  flush: () => Promise<void>
  dispose: () => void
}

function normalizeScopePath(rawPath: string): string {
  const trimmed = rawPath.trim()
  const isWinDrive = /^[a-zA-Z]:[/\\]/.test(trimmed)
  const isUnc = trimmed.startsWith('\\\\') || trimmed.startsWith('//')
  const base = trimmed.startsWith('/') || isWinDrive || isUnc ? trimmed : resolve(trimmed)
  const unified = base.replace(/\\/g, '/').replace(/\/+/g, '/')
  const withUnc = isUnc && !unified.startsWith('//') ? '/' + unified : unified
  if (withUnc === '/' || /^[a-zA-Z]:\/$/.test(withUnc) || withUnc === '//') {
    return withUnc
  }
  return withUnc.endsWith('/') ? withUnc.slice(0, -1) : withUnc
}

function normalizeRootKey(root: string): string {
  const norm = normalizeScopePath(root)
  return isPathCaseInsensitive(norm) ? norm.toLowerCase() : norm
}

function isSubpathOrSame(child: string, parent: string): boolean {
  if (child === parent) return true
  const prefix = parent.endsWith('/') ? parent : `${parent}/`
  return child.startsWith(prefix)
}

export function scopesIntersect(configuredRoot: string, ruleScope: string): boolean {
  const normRoot = normalizeScopePath(configuredRoot)
  const normScope = normalizeScopePath(ruleScope)
  const isCI = isPathCaseInsensitive(normRoot) || isPathCaseInsensitive(normScope)
  const r = isCI ? normRoot.toLowerCase() : normRoot
  const s = isCI ? normScope.toLowerCase() : normScope
  return isSubpathOrSame(r, s) || isSubpathOrSame(s, r)
}

export function createIgnoreReconcileController(
  deps: IgnoreReconcileDeps,
): IgnoreReconcileController {
  const debounceMs = deps.debounceMs ?? 120
  const retryBaseMs = deps.retryBaseMs ?? 300
  const retryMaxMs = deps.retryMaxMs ?? 5_000
  const maxRetries = deps.maxRetries ?? 6

  const dirtyRoots = new Set<string>()
  const runningRoots = new Set<string>()
  const rerunRoots = new Set<string>()
  const deferredBusyRoots = new Set<string>()
  const pendingIncompleteRoots = new Set<string>()
  const pendingUnavailableRoots = new Set<string>()
  const unsupportedRoots = new Set<string>()
  const retryCounts = new Map<string, number>()
  const retryTimers = new Map<string, NodeJS.Timeout>()
  let watchedRunner: Promise<unknown> | null = null
  let observedScan: unknown = null
  let unsubscribeScanRoots: (() => void) | null = null
  let hadConfiguredRoots = false
  let pendingGlobal = false
  let debounceTimer: NodeJS.Timeout | null = null
  let lastScheduledVersion = -1
  let disposed = false

  const configuredRoots = (): string[] =>
    deps
      .getFolderScan()
      ?.folders()
      .map((f) => f.root) ?? []

  const deleteMatchingRoot = (set: Set<string>, root: string): void => {
    const key = normalizeRootKey(root)
    for (const item of [...set]) {
      if (normalizeRootKey(item) === key) {
        set.delete(item)
      }
    }
  }

  const clearRetryTimer = (root: string): void => {
    const key = normalizeRootKey(root)
    for (const [timerRoot, timer] of [...retryTimers.entries()]) {
      if (normalizeRootKey(timerRoot) === key) {
        clearTimeout(timer)
        retryTimers.delete(timerRoot)
      }
    }
  }

  const clearRetryCount = (root: string): void => {
    const key = normalizeRootKey(root)
    for (const countRoot of [...retryCounts.keys()]) {
      if (normalizeRootKey(countRoot) === key) {
        retryCounts.delete(countRoot)
      }
    }
  }

  const clearRootPendingState = (root: string): void => {
    deleteMatchingRoot(dirtyRoots, root)
    deleteMatchingRoot(deferredBusyRoots, root)
    deleteMatchingRoot(pendingIncompleteRoots, root)
    deleteMatchingRoot(pendingUnavailableRoots, root)
    deleteMatchingRoot(unsupportedRoots, root)
    clearRetryTimer(root)
    clearRetryCount(root)
  }

  const pruneRemovedRoots = (allRoots: readonly string[]): void => {
    const validKeys = new Set(allRoots.map(normalizeRootKey))
    const sets = [
      dirtyRoots,
      deferredBusyRoots,
      pendingIncompleteRoots,
      pendingUnavailableRoots,
      unsupportedRoots,
      rerunRoots,
    ]
    for (const set of sets) {
      for (const item of [...set]) {
        if (!validKeys.has(normalizeRootKey(item))) {
          set.delete(item)
          clearRetryTimer(item)
          clearRetryCount(item)
        }
      }
    }
  }

  const scheduleRetry = (root: string, delayMs: number): void => {
    if (disposed) return
    clearRetryTimer(root)
    const timer = setTimeout(() => {
      retryTimers.delete(root)
      void reconcileSingleRoot(root)
    }, delayMs)
    timer.unref?.()
    retryTimers.set(root, timer)
  }

  const wakeDeferredBusyRoots = (): void => {
    if (disposed || deferredBusyRoots.size === 0) return
    const roots = [...deferredBusyRoots]
    deferredBusyRoots.clear()
    for (const r of roots) {
      clearRetryCount(r)
      scheduleRetry(r, debounceMs)
    }
  }

  const onScanLifecycleChange = (): void => {
    if (disposed) return
    const scan = deps.getFolderScan()
    if (!scan) return
    const summaries = scan.folders()
    if (summaries.length > 0) {
      hadConfiguredRoots = true
    }
    if (hadConfiguredRoots) {
      pruneRemovedRoots(summaries.map((f) => f.root))
    }
    const summaryByKey = new Map(summaries.map((f) => [normalizeRootKey(f.root), f]))
    for (const root of [...pendingIncompleteRoots]) {
      const summary = summaryByKey.get(normalizeRootKey(root))
      if (summary && summary.state === 'complete' && !summary.unavailable) {
        deleteMatchingRoot(pendingIncompleteRoots, root)
        clearRetryCount(root)
        scheduleRetry(root, debounceMs)
      }
    }
    for (const root of [...pendingUnavailableRoots]) {
      const summary = summaryByKey.get(normalizeRootKey(root))
      if (summary && !summary.unavailable && summary.state === 'complete') {
        deleteMatchingRoot(pendingUnavailableRoots, root)
        clearRetryCount(root)
        scheduleRetry(root, debounceMs)
      }
    }
    const anyRunning = summaries.some((f) => f.state === 'running')
    if (!anyRunning && deferredBusyRoots.size > 0) {
      wakeDeferredBusyRoots()
    }
  }

  const attachScanLifecycleListener = (
    scan:
      | (Pick<FolderScanManager, 'folders' | 'reconcile'> &
          Partial<Pick<FolderScanManager, 'onRootsChanged' | 'status'>>)
      | null,
  ): void => {
    if (disposed || !scan || observedScan === scan) return
    unsubscribeScanRoots?.()
    unsubscribeScanRoots = null
    observedScan = scan
    if (typeof scan.onRootsChanged === 'function') {
      unsubscribeScanRoots = scan.onRootsChanged(() => {
        onScanLifecycleChange()
      })
    }
  }

  const watchActiveScanRunner = (scan: unknown): void => {
    const candidate = (scan as { runner?: Promise<unknown> | null } | null)?.runner
    if (!candidate || typeof candidate.then !== 'function' || watchedRunner === candidate) {
      return
    }
    watchedRunner = candidate
    void candidate.finally(() => {
      if (watchedRunner === candidate) {
        watchedRunner = null
      }
      onScanLifecycleChange()
      wakeDeferredBusyRoots()
    })
  }

  const reconcileSingleRoot = async (root: string): Promise<void> => {
    if (disposed) return
    if (runningRoots.has(root)) {
      rerunRoots.add(root)
      return
    }
    clearRetryTimer(root)
    runningRoots.add(root)
    try {
      const scan = deps.getFolderScan()
      if (!scan) {
        dirtyRoots.add(root)
        deferredBusyRoots.add(root)
        return
      }
      attachScanLifecycleListener(scan)
      const summaries = scan.folders()
      if (summaries.length > 0) {
        hadConfiguredRoots = true
        const validKeys = new Set(summaries.map((f) => normalizeRootKey(f.root)))
        if (!validKeys.has(normalizeRootKey(root))) {
          clearRootPendingState(root)
          return
        }
      }
      const res = (await scan.reconcile(root)) as { ok?: boolean; reason?: string } | null
      if (disposed) return
      if (res && res.ok === true) {
        clearRootPendingState(root)
        deps.invalidateFolderCounts?.()
        wakeDeferredBusyRoots()
        return
      }

      dirtyRoots.add(root)
      const reason = res && typeof res.reason === 'string' ? res.reason : 'failed'

      if (reason === 'unsupported') {
        deleteMatchingRoot(deferredBusyRoots, root)
        deleteMatchingRoot(pendingIncompleteRoots, root)
        deleteMatchingRoot(pendingUnavailableRoots, root)
        unsupportedRoots.add(root)
        clearRetryCount(root)
        return
      }

      if (reason === 'unavailable') {
        deleteMatchingRoot(deferredBusyRoots, root)
        deleteMatchingRoot(pendingIncompleteRoots, root)
        pendingUnavailableRoots.add(root)
        clearRetryCount(root)
        return
      }

      if (reason === 'not-complete') {
        deleteMatchingRoot(deferredBusyRoots, root)
        pendingIncompleteRoots.add(root)
        watchActiveScanRunner(scan)
        const summary = summaries.find((f) => normalizeRootKey(f.root) === normalizeRootKey(root))
        const hasLifecycleHook =
          typeof scan.onRootsChanged === 'function' ||
          Boolean((scan as { runner?: unknown }).runner)
        if (!hasLifecycleHook && summary?.state !== 'stopped') {
          const attempt = (retryCounts.get(root) ?? 0) + 1
          if (attempt <= maxRetries) {
            retryCounts.set(root, attempt)
            const backoff = Math.min(retryBaseMs * 2 ** (attempt - 1), retryMaxMs)
            scheduleRetry(root, backoff)
          } else {
            clearRetryCount(root)
          }
        } else {
          clearRetryCount(root)
        }
        return
      }

      deferredBusyRoots.add(root)
      const attempt = (retryCounts.get(root) ?? 0) + 1
      if (attempt <= maxRetries) {
        retryCounts.set(root, attempt)
        const backoff = Math.min(retryBaseMs * 2 ** (attempt - 1), retryMaxMs)
        scheduleRetry(root, backoff)
      } else {
        clearRetryCount(root)
        watchActiveScanRunner(scan)
      }
    } catch {
      dirtyRoots.add(root)
      deferredBusyRoots.add(root)
      const attempt = (retryCounts.get(root) ?? 0) + 1
      if (attempt <= maxRetries) {
        retryCounts.set(root, attempt)
        const backoff = Math.min(retryBaseMs * 2 ** (attempt - 1), retryMaxMs)
        scheduleRetry(root, backoff)
      } else {
        clearRetryCount(root)
      }
    } finally {
      runningRoots.delete(root)
      if (!disposed && rerunRoots.has(root)) {
        rerunRoots.delete(root)
        clearRetryCount(root)
        scheduleRetry(root, debounceMs)
      }
    }
  }

  const flush = async (): Promise<void> => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (disposed) return
    const scan = deps.getFolderScan()
    if (scan) {
      attachScanLifecycleListener(scan)
    }
    const allRoots = configuredRoots()
    if (allRoots.length > 0) {
      hadConfiguredRoots = true
    }
    if (hadConfiguredRoots) {
      pruneRemovedRoots(allRoots)
    }
    const targetRoots: string[] = []
    const seen = new Set<string>()
    const addTarget = (r: string): void => {
      const key = normalizeRootKey(r)
      if (!seen.has(key)) {
        seen.add(key)
        targetRoots.push(r)
      }
    }

    if (pendingGlobal) {
      for (const r of allRoots) {
        dirtyRoots.add(r)
        addTarget(r)
      }
      if (scan && (allRoots.length > 0 || !hadConfiguredRoots)) {
        pendingGlobal = false
      }
    }
    for (const r of dirtyRoots) addTarget(r)
    for (const r of deferredBusyRoots) addTarget(r)
    for (const r of pendingIncompleteRoots) addTarget(r)
    for (const r of pendingUnavailableRoots) addTarget(r)

    deps.invalidateFolderCounts?.()
    deps.onRefreshFileIndex?.(targetRoots.length > 0 ? targetRoots : allRoots)

    for (const root of targetRoots) {
      if (disposed) break
      await reconcileSingleRoot(root)
    }
  }

  const schedule = (event?: Partial<IgnorePolicyChangeEvent>): void => {
    if (disposed) return
    const scan = deps.getFolderScan()
    if (scan) {
      attachScanLifecycleListener(scan)
    }
    const version = event?.version ?? getIgnorePolicyGeneration()
    const isNewVersion = event?.version === undefined || version !== lastScheduledVersion

    const allRoots = configuredRoots()
    if (allRoots.length > 0) {
      hadConfiguredRoots = true
    }
    const isScopedOnly =
      event?.globalChanged === false &&
      Array.isArray(event.affectedRoots) &&
      event.affectedRoots.length > 0

    let eventGlobal = !isScopedOnly
    const eventRoots: string[] = []
    if (!isScopedOnly) {
      for (const r of allRoots) eventRoots.push(r)
    } else {
      for (const rawScope of event.affectedRoots!) {
        if (!rawScope || rawScope === 'global') {
          eventGlobal = true
          for (const r of allRoots) eventRoots.push(r)
          continue
        }
        let matchedAny = false
        for (const r of allRoots) {
          if (scopesIntersect(r, rawScope)) {
            eventRoots.push(r)
            matchedAny = true
          }
        }
        if (!matchedAny && allRoots.length === 0) {
          eventRoots.push(rawScope)
        }
      }
    }

    const existingDirtyKeys = new Set([...dirtyRoots].map(normalizeRootKey))
    let addedScope = false
    if (eventGlobal && !pendingGlobal) {
      pendingGlobal = true
      addedScope = true
    }
    for (const r of eventRoots) {
      const key = normalizeRootKey(r)
      if (!existingDirtyKeys.has(key)) {
        existingDirtyKeys.add(key)
        dirtyRoots.add(r)
        addedScope = true
      } else if (isNewVersion) {
        deleteMatchingRoot(unsupportedRoots, r)
      }
      if (runningRoots.has(r) && (isNewVersion || addedScope)) {
        rerunRoots.add(r)
      }
    }

    if (!isNewVersion && !addedScope && (debounceTimer !== null || runningRoots.size > 0)) {
      return
    }
    lastScheduledVersion = version
    deps.invalidateFolderCounts?.()

    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void flush()
    }, debounceMs)
    debounceTimer.unref?.()
  }

  const unsubscribePolicy = subscribeIgnorePolicyChanges((event) => {
    schedule(event)
  })

  if (deps.ipcMain) {
    registerIgnoreIpcHandlers(
      deps.ipcMain,
      () => {
        if (getIgnorePolicyGeneration() !== lastScheduledVersion) {
          schedule({ version: getIgnorePolicyGeneration() })
        }
      },
      configuredRoots,
    )
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    unsubscribePolicy()
    unsubscribeScanRoots?.()
    unsubscribeScanRoots = null
    observedScan = null
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    for (const timer of retryTimers.values()) {
      clearTimeout(timer)
    }
    retryTimers.clear()
    dirtyRoots.clear()
    rerunRoots.clear()
    deferredBusyRoots.clear()
    pendingIncompleteRoots.clear()
    pendingUnavailableRoots.clear()
    unsupportedRoots.clear()
    retryCounts.clear()
  }

  return {
    schedule,
    flush,
    dispose,
  }
}
