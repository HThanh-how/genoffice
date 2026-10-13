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
  getFolderScan: () => Pick<FolderScanManager, 'folders' | 'reconcile'> | null
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
  const retryCounts = new Map<string, number>()
  const retryTimers = new Map<string, NodeJS.Timeout>()
  let watchedRunner: Promise<unknown> | null = null
  let pendingGlobal = false
  let debounceTimer: NodeJS.Timeout | null = null
  let lastScheduledVersion = -1
  let disposed = false

  const configuredRoots = (): string[] =>
    deps
      .getFolderScan()
      ?.folders()
      .map((f) => f.root) ?? []

  const clearRetryTimer = (root: string): void => {
    const timer = retryTimers.get(root)
    if (timer) {
      clearTimeout(timer)
      retryTimers.delete(root)
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
      retryCounts.delete(r)
      scheduleRetry(r, debounceMs)
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
        deferredBusyRoots.add(root)
        return
      }
      const res = (await scan.reconcile(root)) as { ok?: boolean; reason?: string } | null
      if (disposed) return
      if (res && res.ok === false && res.reason === 'busy') {
        const attempt = (retryCounts.get(root) ?? 0) + 1
        if (attempt <= maxRetries) {
          retryCounts.set(root, attempt)
          const backoff = Math.min(retryBaseMs * 2 ** (attempt - 1), retryMaxMs)
          scheduleRetry(root, backoff)
        } else {
          retryCounts.delete(root)
          deferredBusyRoots.add(root)
          watchActiveScanRunner(scan)
        }
        return
      }
      deferredBusyRoots.delete(root)
      retryCounts.delete(root)
      deps.invalidateFolderCounts?.()
      wakeDeferredBusyRoots()
    } catch {
      // Unreadable or disconnected root must not spin or trigger destructive cleanup
      retryCounts.delete(root)
    } finally {
      runningRoots.delete(root)
      if (!disposed && rerunRoots.has(root)) {
        rerunRoots.delete(root)
        retryCounts.delete(root)
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
    const allRoots = configuredRoots()
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
      for (const r of allRoots) addTarget(r)
    }
    for (const r of dirtyRoots) addTarget(r)
    for (const r of deferredBusyRoots) addTarget(r)

    if (deps.getFolderScan()) {
      pendingGlobal = false
    }
    dirtyRoots.clear()
    deferredBusyRoots.clear()

    deps.invalidateFolderCounts?.()
    deps.onRefreshFileIndex?.(targetRoots.length > 0 ? targetRoots : allRoots)

    for (const root of targetRoots) {
      if (disposed) break
      await reconcileSingleRoot(root)
    }
  }

  const schedule = (event?: Partial<IgnorePolicyChangeEvent>): void => {
    if (disposed) return
    const version = event?.version ?? getIgnorePolicyGeneration()
    const isNewVersion = event?.version === undefined || version !== lastScheduledVersion

    const allRoots = configuredRoots()
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
    retryCounts.clear()
  }

  return {
    schedule,
    flush,
    dispose,
  }
}
