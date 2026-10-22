import type { IpcMain } from 'electron'
import { resolve } from 'node:path'
import type { FolderScanManager } from '../document-memory/folder-scan'
import {
  getIgnorePolicyGeneration,
  invalidateKnownRootsCache,
  isPathCaseInsensitive,
  registerIgnoreIpcHandlers,
  subscribeIgnorePolicyChanges,
  type IgnorePolicyChangeEvent,
} from '../document-memory/ignore-policy'

type ReconcileScanHandle = Pick<FolderScanManager, 'folders' | 'reconcile'> &
  Partial<Pick<FolderScanManager, 'onRootsChanged' | 'status'>>
type RegisteredFolderSummary = ReturnType<FolderScanManager['folders']>[number]

export interface IgnoreReconcileDeps {
  ipcMain?: Pick<IpcMain, 'handle'>
  getFolderScan: () => ReconcileScanHandle | null
  onScannerReady?: (listener: () => void) => (() => void) | void
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
  notifyScannerReady: () => void
  dispose: () => void
}

type RootRegistrySnapshot = {
  kind: 'unavailable' | 'uninitialized' | 'empty' | 'ready'
  scan: ReconcileScanHandle | null
  summaries: RegisteredFolderSummary[]
  roots: string[]
}

const MAX_PENDING_SCOPES = 256
const scannerReadyListeners = new Set<() => void>()

export function notifyIgnoreReconcileScannerReady(): void {
  for (const listener of [...scannerReadyListeners]) {
    try {
      listener()
    } catch {
      // A faulty listener must not break scanner initialization.
    }
  }
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
  const maxCooldownRetries = Math.max(maxRetries, 4)
  const maxTotalRetries = maxRetries + maxCooldownRetries
  const cooldownDelayMs = Math.min(retryMaxMs * 2, Math.max(retryMaxMs, retryBaseMs * 4))

  const pendingScopes = new Map<string, string>()
  const dirtyRoots = new Set<string>()
  const runningRoots = new Set<string>()
  const rerunRoots = new Set<string>()
  const deferredBusyRoots = new Set<string>()
  const transientFailedRoots = new Set<string>()
  const pendingIncompleteRoots = new Set<string>()
  const pendingUnavailableRoots = new Set<string>()
  const unsupportedRoots = new Set<string>()
  const retryCounts = new Map<string, number>()
  const retryTimers = new Map<string, NodeJS.Timeout>()
  const scanConfirmedRootKeys = new WeakMap<object, Set<string>>()
  const initializedScans = new WeakSet<object>()
  let everSawConfiguredRoots = false
  let observedScan: ReconcileScanHandle | null = null
  let lastRegistryRetryScan: ReconcileScanHandle | null = null
  let unsubscribeScanRoots: (() => void) | null = null
  let unsubscribeScannerReadyDep: (() => void) | null = null
  let pendingGlobal = false
  let registryRetryCount = 0
  let registryRetryTimer: NodeJS.Timeout | null = null
  let debounceTimer: NodeJS.Timeout | null = null
  let isFlushing = false
  let lastScheduledVersion = -1
  let disposed = false

  const hasPendingRootWork = (): boolean =>
    dirtyRoots.size > 0 ||
    deferredBusyRoots.size > 0 ||
    transientFailedRoots.size > 0 ||
    pendingIncompleteRoots.size > 0 ||
    pendingUnavailableRoots.size > 0

  const hasAnyPendingWork = (): boolean =>
    pendingGlobal || pendingScopes.size > 0 || hasPendingRootWork()

  const hasMatchingRoot = (set: Set<string>, root: string): boolean => {
    const key = normalizeRootKey(root)
    for (const item of set) {
      if (normalizeRootKey(item) === key) return true
    }
    return false
  }

  const deleteMatchingRoot = (set: Set<string>, root: string): void => {
    const key = normalizeRootKey(root)
    for (const item of [...set]) {
      if (normalizeRootKey(item) === key) {
        set.delete(item)
      }
    }
  }

  const getRetryCount = (root: string): number => retryCounts.get(normalizeRootKey(root)) ?? 0

  const setRetryCount = (root: string, count: number): void => {
    retryCounts.set(normalizeRootKey(root), count)
  }

  const clearRetryCount = (root: string): void => {
    retryCounts.delete(normalizeRootKey(root))
  }

  const hasRetryTimer = (root: string): boolean => retryTimers.has(normalizeRootKey(root))

  const clearRetryTimer = (root: string): void => {
    const key = normalizeRootKey(root)
    const timer = retryTimers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      retryTimers.delete(key)
    }
  }

  const clearRegistryRetryTimer = (): void => {
    if (registryRetryTimer) {
      clearTimeout(registryRetryTimer)
      registryRetryTimer = null
    }
  }

  const getConfirmedSetForScan = (scan: ReconcileScanHandle): Set<string> => {
    let set = scanConfirmedRootKeys.get(scan)
    if (!set) {
      set = new Set<string>()
      scanConfirmedRootKeys.set(scan, set)
    }
    return set
  }

  const recordPendingScope = (rawScope: string): boolean => {
    if (pendingGlobal) return false
    const normalized = normalizeScopePath(rawScope)
    const key = normalizeRootKey(normalized)
    if (pendingScopes.has(key)) return false
    if (pendingScopes.size >= MAX_PENDING_SCOPES) {
      pendingScopes.clear()
      pendingGlobal = true
      return true
    }
    pendingScopes.set(key, normalized)
    return true
  }

  const resolvePendingScopes = (
    snapshot: RootRegistrySnapshot,
    finalizeUnmatched: boolean,
  ): string[] => {
    if (
      pendingScopes.size === 0 ||
      snapshot.kind === 'unavailable' ||
      snapshot.kind === 'uninitialized'
    ) {
      return []
    }
    if (snapshot.kind === 'empty') {
      if (finalizeUnmatched && snapshot.scan && initializedScans.has(snapshot.scan)) {
        pendingScopes.clear()
      }
      return []
    }

    const matchedRoots: string[] = []
    for (const [scopeKey, scopePath] of [...pendingScopes.entries()]) {
      let matched = false
      for (const configuredRoot of snapshot.roots) {
        if (scopesIntersect(configuredRoot, scopePath)) {
          matchedRoots.push(configuredRoot)
          matched = true
        }
      }
      if (matched || finalizeUnmatched) {
        pendingScopes.delete(scopeKey)
      }
    }
    return matchedRoots
  }

  const scheduleFlushSoon = (delayMs = debounceMs): void => {
    if (disposed || debounceTimer !== null || isFlushing) return
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void flush()
    }, delayMs)
    debounceTimer.unref?.()
  }

  const inspectScanRoots = (): RootRegistrySnapshot => {
    let scan: ReconcileScanHandle | null
    try {
      scan = deps.getFolderScan()
    } catch {
      scan = null
    }
    if (!scan || typeof scan.folders !== 'function') {
      return { kind: 'unavailable', scan: null, summaries: [], roots: [] }
    }

    let summaries: RegisteredFolderSummary[]
    try {
      const raw = scan.folders()
      if (!Array.isArray(raw)) {
        return { kind: 'unavailable', scan: null, summaries: [], roots: [] }
      }
      summaries = raw
    } catch {
      return { kind: 'unavailable', scan: null, summaries: [], roots: [] }
    }

    if (scan !== lastRegistryRetryScan) {
      lastRegistryRetryScan = scan
      registryRetryCount = 0
    }
    if (scan !== observedScan) {
      attachScanLifecycleListener(scan)
      if (hasAnyPendingWork()) {
        scheduleFlushSoon(Math.min(debounceMs, 15))
      }
    }

    const confirmedOnScan = getConfirmedSetForScan(scan)
    if (summaries.length > 0) {
      initializedScans.add(scan)
      everSawConfiguredRoots = true
      for (const summary of summaries) {
        confirmedOnScan.add(normalizeRootKey(summary.root))
      }
      return {
        kind: 'ready',
        scan,
        summaries,
        roots: summaries.map((f) => f.root),
      }
    }

    if (!initializedScans.has(scan) && (everSawConfiguredRoots || hasAnyPendingWork())) {
      return { kind: 'uninitialized', scan, summaries: [], roots: [] }
    }

    return { kind: 'empty', scan, summaries: [], roots: [] }
  }

  const configuredRoots = (): string[] => inspectScanRoots().roots

  const scheduleRegistryRetry = (): void => {
    if (disposed || (!pendingGlobal && pendingScopes.size === 0) || registryRetryTimer) return
    const attempt = registryRetryCount + 1
    if (attempt > maxTotalRetries) return
    registryRetryCount = attempt
    const backoff =
      attempt <= maxRetries
        ? Math.min(retryBaseMs * 2 ** (attempt - 1), retryMaxMs)
        : cooldownDelayMs
    registryRetryTimer = setTimeout(() => {
      registryRetryTimer = null
      void flush()
    }, backoff)
    registryRetryTimer.unref?.()
  }

  const clearRootPendingState = (root: string): void => {
    deleteMatchingRoot(dirtyRoots, root)
    deleteMatchingRoot(deferredBusyRoots, root)
    deleteMatchingRoot(transientFailedRoots, root)
    deleteMatchingRoot(pendingIncompleteRoots, root)
    deleteMatchingRoot(pendingUnavailableRoots, root)
    deleteMatchingRoot(unsupportedRoots, root)
    clearRetryTimer(root)
    clearRetryCount(root)
  }

  const pruneConfirmedRemovedRoots = (snapshot: RootRegistrySnapshot): void => {
    if (!snapshot.scan || snapshot.kind === 'unavailable' || snapshot.kind === 'uninitialized') {
      return
    }
    const confirmedOnScan = getConfirmedSetForScan(snapshot.scan)
    if (confirmedOnScan.size === 0) {
      return
    }
    const currentKeys = new Set(snapshot.roots.map(normalizeRootKey))
    const removedKeys = new Set<string>()
    for (const seenKey of [...confirmedOnScan]) {
      if (!currentKeys.has(seenKey)) {
        removedKeys.add(seenKey)
        confirmedOnScan.delete(seenKey)
      }
    }
    if (removedKeys.size === 0) return

    const sets = [
      dirtyRoots,
      deferredBusyRoots,
      transientFailedRoots,
      pendingIncompleteRoots,
      pendingUnavailableRoots,
      unsupportedRoots,
      rerunRoots,
    ]
    for (const set of sets) {
      for (const item of [...set]) {
        if (removedKeys.has(normalizeRootKey(item))) {
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
    const key = normalizeRootKey(root)
    const timer = setTimeout(() => {
      retryTimers.delete(key)
      void reconcileSingleRoot(root)
    }, delayMs)
    timer.unref?.()
    retryTimers.set(key, timer)
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
    // the root list changed: ignore evaluation must not keep resolving against the old one
    invalidateKnownRootsCache()
    const snapshot = inspectScanRoots()
    if (!snapshot.scan || snapshot.kind === 'unavailable') return

    pruneConfirmedRemovedRoots(snapshot)

    if (snapshot.kind === 'ready' && pendingScopes.size > 0) {
      const resolvedRoots = resolvePendingScopes(snapshot, false)
      for (const r of resolvedRoots) {
        if (!hasMatchingRoot(dirtyRoots, r)) {
          dirtyRoots.add(r)
        }
        if (!hasRetryTimer(r) && !hasMatchingRoot(runningRoots, r)) {
          clearRetryCount(r)
          scheduleRetry(r, debounceMs)
        }
      }
      if (pendingScopes.size > 0) {
        scheduleFlushSoon(debounceMs)
      }
    }

    if (pendingGlobal && snapshot.kind === 'ready') {
      clearRegistryRetryTimer()
      registryRetryCount = 0
      void flush()
      return
    }

    const summaryByKey = new Map(snapshot.summaries.map((f) => [normalizeRootKey(f.root), f]))
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
      if (
        summary &&
        !summary.unavailable &&
        summary.state === 'complete' &&
        !hasRetryTimer(root) &&
        !hasMatchingRoot(runningRoots, root)
      ) {
        setRetryCount(root, maxRetries)
        scheduleRetry(root, debounceMs)
      }
    }
    for (const root of [...transientFailedRoots]) {
      const summary = summaryByKey.get(normalizeRootKey(root))
      if (
        summary &&
        !summary.unavailable &&
        summary.state === 'complete' &&
        !hasRetryTimer(root) &&
        !hasMatchingRoot(runningRoots, root)
      ) {
        setRetryCount(root, maxTotalRetries)
        scheduleRetry(root, debounceMs)
      }
    }
    const statusRunning = snapshot.scan.status?.().running === true
    const anyRunning = statusRunning || snapshot.summaries.some((f) => f.state === 'running')
    if (!anyRunning && deferredBusyRoots.size > 0) {
      wakeDeferredBusyRoots()
    }
  }

  const attachScanLifecycleListener = (scan: ReconcileScanHandle | null): void => {
    if (disposed || !scan || observedScan === scan) return
    const previousScan = observedScan
    unsubscribeScanRoots?.()
    unsubscribeScanRoots = null
    observedScan = scan
    if (previousScan !== null) {
      registryRetryCount = 0
      retryCounts.clear()
      for (const r of [...unsupportedRoots]) {
        unsupportedRoots.delete(r)
        if (!hasMatchingRoot(dirtyRoots, r)) {
          dirtyRoots.add(r)
        }
      }
    }
    if (typeof scan.onRootsChanged === 'function') {
      unsubscribeScanRoots = scan.onRootsChanged(() => {
        onScanLifecycleChange()
      })
    }
  }

  const notifyScannerReady = (): void => {
    if (disposed) return
    clearRegistryRetryTimer()
    registryRetryCount = 0
    for (const root of [...deferredBusyRoots, ...transientFailedRoots, ...pendingIncompleteRoots]) {
      clearRetryCount(root)
    }
    const snapshot = inspectScanRoots()
    if (snapshot.scan) {
      attachScanLifecycleListener(snapshot.scan)
    }
    if (hasAnyPendingWork()) {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      if (!isFlushing) {
        void flush()
      }
    }
  }

  const scheduleTransientOrBusyRetry = (root: string, isBusy: boolean): void => {
    const attempt = getRetryCount(root) + 1
    if (attempt <= maxRetries) {
      setRetryCount(root, attempt)
      const backoff = Math.min(retryBaseMs * 2 ** (attempt - 1), retryMaxMs)
      scheduleRetry(root, backoff)
    } else if (attempt <= maxTotalRetries) {
      setRetryCount(root, attempt)
      scheduleRetry(root, isBusy ? retryMaxMs : cooldownDelayMs)
    } else {
      setRetryCount(root, maxTotalRetries)
    }
  }

  const reconcileSingleRoot = async (root: string): Promise<void> => {
    if (disposed) return
    if (hasMatchingRoot(runningRoots, root)) {
      if (!hasMatchingRoot(rerunRoots, root)) {
        rerunRoots.add(root)
      }
      return
    }
    clearRetryTimer(root)
    runningRoots.add(root)
    try {
      const snapshot = inspectScanRoots()
      const scan = snapshot.scan
      if (!scan || snapshot.kind === 'unavailable') {
        if (!hasMatchingRoot(dirtyRoots, root)) dirtyRoots.add(root)
        if (!hasMatchingRoot(deferredBusyRoots, root)) deferredBusyRoots.add(root)
        scheduleTransientOrBusyRetry(root, true)
        return
      }

      attachScanLifecycleListener(scan)
      pruneConfirmedRemovedRoots(snapshot)

      const rootKey = normalizeRootKey(root)
      const confirmedOnScan = getConfirmedSetForScan(scan)
      const currentKeys = new Set(snapshot.roots.map(normalizeRootKey))
      if (confirmedOnScan.has(rootKey) && !currentKeys.has(rootKey)) {
        confirmedOnScan.delete(rootKey)
        clearRootPendingState(root)
        return
      }

      if (snapshot.kind === 'ready' && !currentKeys.has(rootKey)) {
        clearRootPendingState(root)
        return
      }

      const res = await scan.reconcile(root)
      if (disposed) return
      if (res && res.ok === true) {
        confirmedOnScan.add(rootKey)
        everSawConfiguredRoots = true
        clearRootPendingState(root)
        deps.invalidateFolderCounts?.()
        wakeDeferredBusyRoots()
        return
      }

      const reason = res && typeof res.reason === 'string' ? res.reason : 'failed'

      if (reason === 'unsupported') {
        deleteMatchingRoot(dirtyRoots, root)
        deleteMatchingRoot(deferredBusyRoots, root)
        deleteMatchingRoot(transientFailedRoots, root)
        deleteMatchingRoot(pendingIncompleteRoots, root)
        deleteMatchingRoot(pendingUnavailableRoots, root)
        if (!hasMatchingRoot(unsupportedRoots, root)) {
          unsupportedRoots.add(root)
        }
        clearRetryTimer(root)
        clearRetryCount(root)
        return
      }

      if (!hasMatchingRoot(dirtyRoots, root)) {
        dirtyRoots.add(root)
      }

      if (reason === 'unavailable') {
        deleteMatchingRoot(deferredBusyRoots, root)
        deleteMatchingRoot(transientFailedRoots, root)
        deleteMatchingRoot(pendingIncompleteRoots, root)
        if (!hasMatchingRoot(pendingUnavailableRoots, root)) {
          pendingUnavailableRoots.add(root)
        }
        const attempt = getRetryCount(root) + 1
        if (attempt <= maxRetries) {
          setRetryCount(root, attempt)
          const backoff = Math.min(retryBaseMs * 2 ** (attempt - 1), retryMaxMs)
          scheduleRetry(root, backoff)
        } else {
          setRetryCount(root, maxRetries)
        }
        return
      }

      if (reason === 'not-complete') {
        deleteMatchingRoot(deferredBusyRoots, root)
        deleteMatchingRoot(transientFailedRoots, root)
        if (!hasMatchingRoot(pendingIncompleteRoots, root)) {
          pendingIncompleteRoots.add(root)
        }
        const summary = snapshot.summaries.find((f) => normalizeRootKey(f.root) === rootKey)
        const hasLifecycleHook = typeof scan.onRootsChanged === 'function'
        if (!hasLifecycleHook && summary?.state !== 'stopped') {
          scheduleTransientOrBusyRetry(root, false)
        } else {
          clearRetryCount(root)
        }
        return
      }

      if (reason === 'busy') {
        deleteMatchingRoot(transientFailedRoots, root)
        if (!hasMatchingRoot(deferredBusyRoots, root)) {
          deferredBusyRoots.add(root)
        }
        scheduleTransientOrBusyRetry(root, true)
        return
      }

      deleteMatchingRoot(deferredBusyRoots, root)
      if (!hasMatchingRoot(transientFailedRoots, root)) {
        transientFailedRoots.add(root)
      }
      scheduleTransientOrBusyRetry(root, false)
    } catch {
      if (!hasMatchingRoot(dirtyRoots, root)) {
        dirtyRoots.add(root)
      }
      deleteMatchingRoot(deferredBusyRoots, root)
      if (!hasMatchingRoot(transientFailedRoots, root)) {
        transientFailedRoots.add(root)
      }
      scheduleTransientOrBusyRetry(root, false)
    } finally {
      deleteMatchingRoot(runningRoots, root)
      if (!disposed && hasMatchingRoot(rerunRoots, root)) {
        deleteMatchingRoot(rerunRoots, root)
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
    isFlushing = true
    try {
      const snapshot = inspectScanRoots()
      if (snapshot.scan) {
        attachScanLifecycleListener(snapshot.scan)
      }
      pruneConfirmedRemovedRoots(snapshot)

      const allRoots = snapshot.roots
      const targetRoots: string[] = []
      const seen = new Set<string>()
      const addTarget = (r: string): void => {
        const key = normalizeRootKey(r)
        if (!seen.has(key)) {
          seen.add(key)
          targetRoots.push(r)
        }
      }

      if (pendingScopes.size > 0) {
        const resolvedFromScopes = resolvePendingScopes(snapshot, true)
        for (const r of resolvedFromScopes) {
          if (!hasMatchingRoot(dirtyRoots, r)) {
            dirtyRoots.add(r)
          }
          addTarget(r)
        }
      }

      if (pendingGlobal) {
        for (const r of allRoots) {
          if (!hasMatchingRoot(dirtyRoots, r)) {
            dirtyRoots.add(r)
          }
          addTarget(r)
        }
        if (snapshot.kind === 'ready' || snapshot.kind === 'empty') {
          pendingGlobal = false
          clearRegistryRetryTimer()
          registryRetryCount = 0
        }
      }

      if (
        (pendingGlobal || pendingScopes.size > 0) &&
        (snapshot.kind === 'unavailable' || snapshot.kind === 'uninitialized')
      ) {
        scheduleRegistryRetry()
      } else if (!pendingGlobal && pendingScopes.size === 0) {
        clearRegistryRetryTimer()
        registryRetryCount = 0
      }

      for (const r of dirtyRoots) addTarget(r)
      for (const r of deferredBusyRoots) addTarget(r)
      for (const r of transientFailedRoots) addTarget(r)
      for (const r of pendingIncompleteRoots) addTarget(r)
      for (const r of pendingUnavailableRoots) addTarget(r)

      deps.invalidateFolderCounts?.()
      deps.onRefreshFileIndex?.(targetRoots.length > 0 ? targetRoots : allRoots)

      for (const root of targetRoots) {
        if (disposed) break
        await reconcileSingleRoot(root)
      }
    } finally {
      isFlushing = false
    }
  }

  const schedule = (event?: Partial<IgnorePolicyChangeEvent>): void => {
    if (disposed) return
    const snapshot = inspectScanRoots()
    if (snapshot.scan) {
      attachScanLifecycleListener(snapshot.scan)
    }
    const version = event?.version ?? getIgnorePolicyGeneration()
    const isNewVersion = event?.version === undefined || version !== lastScheduledVersion

    const allRoots = snapshot.roots
    const isScopedOnly =
      event?.globalChanged === false &&
      Array.isArray(event.affectedRoots) &&
      event.affectedRoots.length > 0

    let eventGlobal = !isScopedOnly
    const eventRoots: string[] = []
    let addedPendingScope = false

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
        if (!matchedAny && snapshot.kind !== 'ready') {
          if (recordPendingScope(rawScope)) {
            addedPendingScope = true
          }
        }
      }
    }

    const existingDirtyKeys = new Set([...dirtyRoots].map(normalizeRootKey))
    let addedScope = addedPendingScope
    if (eventGlobal) {
      pendingScopes.clear()
      clearRegistryRetryTimer()
      registryRetryCount = 0
      if (!pendingGlobal) {
        pendingGlobal = true
        addedScope = true
      }
      if (isNewVersion) {
        for (const r of [...unsupportedRoots]) {
          unsupportedRoots.delete(r)
          eventRoots.push(r)
        }
        for (const r of [...transientFailedRoots, ...pendingUnavailableRoots]) {
          clearRetryCount(r)
        }
      }
    } else if (addedPendingScope) {
      clearRegistryRetryTimer()
      registryRetryCount = 0
    }

    for (const r of eventRoots) {
      const key = normalizeRootKey(r)
      if (!existingDirtyKeys.has(key)) {
        existingDirtyKeys.add(key)
        dirtyRoots.add(r)
        addedScope = true
      }
      if (isNewVersion) {
        deleteMatchingRoot(unsupportedRoots, r)
        clearRetryCount(r)
      }
      if (hasMatchingRoot(runningRoots, r) && (isNewVersion || addedScope)) {
        if (!hasMatchingRoot(rerunRoots, r)) {
          rerunRoots.add(r)
        }
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

  scannerReadyListeners.add(notifyScannerReady)
  if (typeof deps.onScannerReady === 'function') {
    const unsub = deps.onScannerReady(notifyScannerReady)
    if (typeof unsub === 'function') {
      unsubscribeScannerReadyDep = unsub
    }
  }

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
    scannerReadyListeners.delete(notifyScannerReady)
    unsubscribeScannerReadyDep?.()
    unsubscribeScannerReadyDep = null
    unsubscribeScanRoots?.()
    unsubscribeScanRoots = null
    observedScan = null
    lastRegistryRetryScan = null
    clearRegistryRetryTimer()
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    for (const timer of retryTimers.values()) {
      clearTimeout(timer)
    }
    retryTimers.clear()
    pendingScopes.clear()
    dirtyRoots.clear()
    rerunRoots.clear()
    deferredBusyRoots.clear()
    transientFailedRoots.clear()
    pendingIncompleteRoots.clear()
    pendingUnavailableRoots.clear()
    unsupportedRoots.clear()
    retryCounts.clear()
  }

  return {
    schedule,
    flush,
    notifyScannerReady,
    dispose,
  }
}
