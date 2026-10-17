/**
 * Every PDF branch must carry the batch that picked the output folder.
 *
 * A grouped export prints the document in pieces and merges them in the main
 * process. The writer decides whether a target is authorized by the batch id the
 * request states — so a branch that drops the argument silently turns a batch
 * write into an unclaimed request. The grouped branch used to do exactly that
 * while the retry branch passed the token.
 *
 * These tests drive the real `exportPdf` with a stubbed print bridge and assert
 * what the IPC actually receives, for one page, mixed paper, chunked uniform
 * paper, a failed print that retries, and an export parked until the preview
 * mounts.
 */
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx, type ParsedDocFull } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { exportPdf, type FileActionContext } from '../src/renderer/file-actions'

interface PrintCall {
  method: 'exportPdf' | 'saveMergedPdf' | 'printPdfBuffer'
  outPath?: string
  batch?: string
  parts?: number
}

function stubDesktop(behaviour: 'ok' | 'fail-first'): { calls: PrintCall[] } {
  const calls: PrintCall[] = []
  let exportAttempts = 0
  Object.assign(window, {
    desktop: {
      printPdfBuffer: async (w: number, h: number) => {
        calls.push({ method: 'printPdfBuffer', outPath: `${w}x${h}` })
        return { ok: true, base64: Buffer.from('%PDF-1.4 group').toString('base64') }
      },
      saveMergedPdf: (
        _name: string,
        parts: string[],
        outPath: string | undefined,
        _links: unknown,
        _overwrite: string | undefined,
        batch: string | undefined,
      ) => {
        calls.push({ method: 'saveMergedPdf', outPath, batch, parts: parts.length })
        return { ok: true, path: outPath ?? 'merged.pdf', name: 'merged.pdf' }
      },
      exportPdf: (
        _name: string,
        _w: number,
        _h: number,
        outPath: string | undefined,
        _scale: number | undefined,
        _links: unknown,
        _overwrite: string | undefined,
        batch: string | undefined,
      ) => {
        exportAttempts += 1
        calls.push({ method: 'exportPdf', outPath, batch })
        if (behaviour === 'fail-first' && exportAttempts === 1) {
          // Chromium rejected the whole job; the path is already authorized so
          // the renderer retries it in smaller print groups
          return { ok: false, error: 'print failed', path: outPath }
        }
        return { ok: true, path: outPath ?? 'one.pdf', name: 'one.pdf' }
      },
    },
  })
  return { calls }
}

function printSheets(sizes: Array<[number, number]>) {
  document.querySelectorAll('.pagination-preview').forEach((el) => el.remove())
  const root = document.createElement('div')
  root.className = 'pagination-preview'
  for (const [w, h] of sizes) {
    const page = document.createElement('div')
    page.className = 'pv-page'
    page.style.width = `${w}px`
    page.style.height = `${h}px`
    root.appendChild(page)
  }
  document.body.appendChild(root)
  return () => root.remove()
}

async function makeCtx(): Promise<FileActionContext> {
  const bytes = await buildDocx({
    bodyXml: '<w:p><w:r><w:t xml:space="preserve">text</w:t></w:r></w:p>',
  })
  const parsed: ParsedDocFull = await parseDocx(bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks),
  })
  return {
    editor,
    doc: { parsed, filePath: null, fileName: 'template.docx', hash: '' },
    sections: [],
    section: null,
    setStatus: () => {},
    setShowPagePreview: () => {},
    pendingMixedExportRef: { current: false },
    bumpPendingExportTick: () => {},
  } as unknown as FileActionContext
}

describe('the batch token in every PDF export branch', () => {
  it('passes the batch to a one-page export', async () => {
    const ctx = await makeCtx()
    const stop = printSheets([[595, 842]])
    const { calls } = stubDesktop('ok')
    const result = await exportPdf(ctx, '/out/1_Alpha.pdf', 'overwrite', 'batch-a')
    stop()
    ctx.editor?.destroy()

    expect(result.ok).toBe(true)
    expect(calls.map((c) => c.method)).toEqual(['exportPdf'])
    expect(calls[0].batch).toBe('batch-a')
    expect(calls[0].outPath).toBe('/out/1_Alpha.pdf')
  })

  it('passes the batch to a mixed paper-size export that merges groups', async () => {
    const ctx = await makeCtx()
    // A4 then Letter: two print groups, merged by pdf-lib
    const stop = printSheets([
      [595, 842],
      [595, 842],
      [770, 1000],
    ])
    const { calls } = stubDesktop('ok')
    const result = await exportPdf(ctx, '/out/2_Beta.pdf', 'skip', 'batch-a')
    stop()
    ctx.editor?.destroy()

    expect(result.ok).toBe(true)
    const merged = calls.filter((c) => c.method === 'saveMergedPdf')
    expect(merged.length).toBe(1)
    expect(merged[0].batch).toBe('batch-a')
    expect(merged[0].outPath).toBe('/out/2_Beta.pdf')
    expect(merged[0].parts).toBe(2)
  })

  it('passes the batch when a uniform document is chunked into groups', async () => {
    const ctx = await makeCtx()
    // 12 uniform pages exceed the 10-page print chunk, so the export goes
    // through the group-merge path even though every page is the same size
    const stop = printSheets(Array.from({ length: 12 }, () => [595, 842]))
    const { calls } = stubDesktop('ok')
    const result = await exportPdf(ctx, '/out/3_Gamma.pdf', 'rename', 'batch-a')
    stop()
    ctx.editor?.destroy()

    expect(result.ok).toBe(true)
    const merged = calls.filter((c) => c.method === 'saveMergedPdf')
    expect(merged.length).toBe(1)
    expect(merged[0].batch).toBe('batch-a')
    expect(merged[0].parts).toBe(2)
  })

  it('passes the batch when a failed print retries through the merge path', async () => {
    const ctx = await makeCtx()
    const stop = printSheets([
      [595, 842],
      [595, 842],
    ])
    const { calls } = stubDesktop('fail-first')
    const result = await exportPdf(ctx, '/out/4_Delta.pdf', 'overwrite', 'batch-a')
    stop()
    ctx.editor?.destroy()

    expect(result.ok).toBe(true)
    const merged = calls.filter((c) => c.method === 'saveMergedPdf')
    expect(merged.length).toBe(1)
    expect(merged[0].batch).toBe('batch-a')
    expect(merged[0].outPath).toBe('/out/4_Delta.pdf')
  })

  it('keeps the batch on an export parked until the preview mounts', async () => {
    const ctx = await makeCtx()
    document.querySelectorAll('.pagination-preview').forEach((el) => el.remove())
    const { calls } = stubDesktop('ok')
    // the deferral promise is settled by the App effect, which this test runner
    // does not have; the request is parked synchronously, so it can be read
    // straight off the ref without awaiting a promise that never settles
    void exportPdf(ctx, '/out/5_Epsilon.pdf', 'skip', 'batch-a')
    // the deferral is recorded after the content wait, so give it a tick
    await new Promise((resolve) => setTimeout(resolve, 200))
    ctx.editor?.destroy()

    // nothing has printed yet: the request is held, with its identity intact,
    // until the pagination preview is measured
    expect(calls).toEqual([])
    const pending = (ctx as unknown as { pendingMixedExportRef: { current: unknown } })
      .pendingMixedExportRef.current
    expect(pending).not.toBe(false)
    expect((pending as { batch?: string; outPath?: string }).batch).toBe('batch-a')
    expect((pending as { outPath?: string }).outPath).toBe('/out/5_Epsilon.pdf')
  })

  it('leaves an ordinary File-menu export without a batch token', async () => {
    const ctx = await makeCtx()
    const stop = printSheets([[595, 842]])
    const { calls } = stubDesktop('ok')
    const result = await exportPdf(ctx)
    stop()
    ctx.editor?.destroy()

    expect(result.ok).toBe(true)
    expect(calls[0].method).toBe('exportPdf')
    expect(calls[0].batch).toBeUndefined()
  })
})
