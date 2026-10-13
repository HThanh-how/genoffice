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

function normalizeRootKey(root: string): string {
  const resolved = resolve(root).replace(/\\/g, '/')
  return isPathCaseInsensitive(resolved) ? resolved.toLowerCase() : resolved
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
  const retryCounts = new Map<string, number>()
  const retryTimers = new Map<string, NodeJS.Timeout>()
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
      if (!scan) return
      const res = (await scan.reconcile(root)) as { ok?: boolean; reason?: string } | null
      if (disposed) return
      if (res && res.ok === false && res.reason === 'busy') {
        const attempt = (retryCounts.get(root) ?? 0) + 1
        if (attempt <= maxRetries) {
          retryCounts.set(root, attempt)
          const backoff = Math.min(retryBaseMs * 2 ** (attempt - 1), retryMaxMs)
          scheduleRetry(root, backoff)
        }
        return
      }
      retryCounts.delete(root)
      deps.invalidateFolderCounts?.()
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

    pendingGlobal = false
    dirtyRoots.clear()

    deps.invalidateFolderCounts?.()
    deps.onRefreshFileIndex?.(targetRoots.length > 0 ? targetRoots : allRoots)

    await Promise.all(targetRoots.map((root) => reconcileSingleRoot(root)))
  }

  const schedule = (event?: Partial<IgnorePolicyChangeEvent>): void => {
    if (disposed) return
    const version = event?.version ?? getIgnorePolicyGeneration()
    if (
      event?.version !== undefined &&
      version === lastScheduledVersion &&
      (debounceTimer !== null || runningRoots.size > 0)
    ) {
      return
    }
    lastScheduledVersion = version
    deps.invalidateFolderCounts?.()

    const allRoots = configuredRoots()
    const isScopedOnly =
      event?.globalChanged === false &&
      Array.isArray(event.affectedRoots) &&
      event.affectedRoots.length > 0

    if (!isScopedOnly) {
      pendingGlobal = true
      for (const r of allRoots) dirtyRoots.add(r)
    } else {
      const byKey = new Map<string, string>()
      for (const r of allRoots) byKey.set(normalizeRootKey(r), r)
      for (const rawScope of event.affectedRoots!) {
        const matched = byKey.get(normalizeRootKey(rawScope))
        if (matched) {
          dirtyRoots.add(matched)
        } else if (allRoots.length === 0) {
          dirtyRoots.add(rawScope)
        }
      }
    }

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
        schedule({ version: getIgnorePolicyGeneration() })
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
    retryCounts.clear()
  }

  return {
    schedule,
    flush,
    dispose,
  }
}
