import { useContext, useMemo, useRef, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexBrowserQuery } from '../../../shared/fork/index-browser'
import type { FileItem } from './IndexFiles'
import { appConfirm } from '../ui-feedback'
import { useI18n } from '../locale'
import { fill } from '../indexing-activity-copy'
import { indexV2Words } from '../i18n/strings-index-v2'
import { runIndexMutation } from './index-mutation'
import { IndexRuntime } from './IndexRuntime'
import { createIndexSourceLookup } from './index-list-view'
import { indexRowActions } from './index-row-state'
import { liveOf } from './IndexFiles'
import { isOcrCandidate } from './index-bulk-actions'

export type IndexBulkAction =
  'retry' | 'ocr' | 'remove' | 'exclude' | 'trash' | 'later' | 'stop' | 'copy' | 'reveal'
export interface IndexAllSelection {
  query: IndexBrowserQuery
  total: number
  except?: ReadonlySet<number>
}
export function useIndexBulk(api: HomeApi, onChanged: () => void) {
  const { lang } = useI18n()
  const w = indexV2Words(lang)
  const { now, sources } = useContext(IndexRuntime)
  const isOffline = useMemo(() => createIndexSourceLookup(sources), [sources])
  const availability = (item: FileItem) =>
    indexRowActions(
      { ...item, offline: !!item.offline || isOffline(item.path) },
      liveOf(now, item.path)?.kind,
    )
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const inFlight = useRef(false)
  const run = async (mode: IndexBulkAction, target: FileItem[] | IndexAllSelection) => {
    const count = Array.isArray(target) ? target.length : target.total - (target.except?.size ?? 0)
    if (inFlight.current || !count) return
    inFlight.current = true
    setBusy(true)
    setNote('')
    let touched = false
    try {
      if (['ocr', 'trash', 'remove', 'exclude'].includes(mode)) {
        const message =
          mode === 'ocr' ? w.confirmOcr : mode === 'trash' ? w.confirmTrash : w.confirmRemove
        if (
          !(await appConfirm(fill(message, { n: count }), {
            tone: mode === 'ocr' ? 'info' : 'danger',
          }))
        )
          return
      }
      const copied: string[] = []
      let queued = 0
      let stopped = 0
      const processPage = async (items: FileItem[]) => {
        if (mode === 'later') items = items.filter((item) => availability(item).defer)
        if (mode === 'stop')
          items = items.filter(
            (item) =>
              availability(item).stop ||
              (item.id > 0 && /\.pdf$/i.test(item.path) && !!api.cancelScannedPdfsWithAgy),
          )
        if (!items.length) return
        touched = true
        if (mode === 'copy') copied.push(...items.map((i) => i.path))
        else if (mode === 'reveal') {
          const first = items[0]!
          if (first.id > 0) await api.revealDocumentIndexFile(first.id)
          else await api.openFolderInFileManager(first.path.replace(/[\\/][^\\/]*$/, ''))
        } else if (mode === 'trash') {
          const result = await runIndexMutation(() => api.deleteFiles(items.map((i) => i.path)))
          if (result.failed) throw new Error('trash failed')
        } else if (mode === 'retry' || mode === 'ocr') {
          const ids = items
            .filter(
              (i) =>
                i.id > 0 &&
                (mode === 'ocr' ? availability(i).ocr && isOcrCandidate(i) : availability(i).retry),
            )
            .map((i) => i.id)
          for (let offset = 0; offset < ids.length; offset += 200) {
            const chunk = ids.slice(offset, offset + 200)
            const result = await runIndexMutation(() =>
              mode === 'ocr'
                ? api.enqueueScannedPdfsWithAgy!(chunk, true)
                : api.enqueueDocumentIndex!(chunk),
            )
            if (result.error) throw new Error(result.error)
            queued += result.queued
          }
        } else
          for (const item of items) {
            if (mode === 'stop') {
              if (api.cancelScannedPdfsWithAgy && /\.pdf$/i.test(item.path))
                stopped += await runIndexMutation(() => api.cancelScannedPdfsWithAgy!([item.id]))
              if (!availability(item).stop) continue
            }
            if (mode === 'remove' && item.id > 0 && api.cancelScannedPdfsWithAgy)
              await runIndexMutation(() => api.cancelScannedPdfsWithAgy!([item.id]))
            const result = await runIndexMutation<unknown>(() =>
              mode === 'later'
                ? api.deferIndexFile(item.id)
                : mode === 'stop'
                  ? api.stopIndexFile(item.id)
                  : mode === 'exclude'
                    ? api.addIndexIgnore!(item.path)
                    : api.excludeDocumentMemory(item.path),
            )
            if (result && typeof result === 'object' && 'ok' in result && !result.ok)
              throw new Error('action failed')
            if (mode === 'stop') stopped++
          }
      }
      if (Array.isArray(target)) await processPage(target)
      else {
        // Keyset pages keep selection bounded and stable even when an action removes matching rows.
        // throughId freezes the selection at the last id present when the person selected the group.
        let afterId = 0
        for (;;) {
          const page = await api.getIndexBrowserPage!({ ...target.query, offset: 0, afterId })
          if (!page.items.length) break
          const next = Math.max(...page.items.map((i) => i.id))
          if (next <= afterId) throw new Error('File page did not advance')
          afterId = next
          await processPage(page.items.filter((i) => !target.except?.has(i.id)))
          if (mode === 'reveal' && touched) break
        }
      }
      if (mode === 'copy') await navigator.clipboard.writeText(copied.join('\n'))
      if ((mode === 'retry' || mode === 'ocr') && !queued) throw new Error('No files were queued')
      if (!touched || (mode === 'stop' && !stopped)) throw new Error('No eligible files')
      setNote(w.done)
    } catch {
      setNote(w.failed)
    } finally {
      if (touched) onChanged()
      inFlight.current = false
      setBusy(false)
    }
  }
  return { run, busy, note }
}
