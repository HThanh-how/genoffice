/**
 * Who owns the output directory, and for how long.
 *
 * A mail-merge batch is granted a folder when the user picks it. The grant
 * belongs to that batch, not to the tab: closing the dialog releases it, and a
 * write that is still in flight — materialising lazy media, verifying the
 * finished .docx — must not commit after the release.
 *
 * `runCommit` is the production handler's sequence with the real writer and the
 * real output contract; only the grant bookkeeping is a local map, so a passing
 * test means the ordering is safe, not that a helper was written correctly.
 */
import { existsSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { commitMailMergeWrite } from '../src/shared/mail-merge-commit'
import {
  decideMailMergeWrite,
  MAX_MAIL_MERGE_OUTPUT_BYTES,
  MAX_MAIL_MERGE_PAYLOAD_BYTES,
  type MailMergeGrant,
} from '../src/shared/mail-merge-ipc'
import { containedTarget, posixRules } from '../src/shared/output-containment'

const freshDir = () => mkdtemp(join(tmpdir(), 'genoffice-mm-grant-'))
const freshDirSync = () => realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-mm-grant-')))
const listing = async (dir: string) => (await readdir(dir)).sort()
const contained = (dir: string, path: string) =>
  containedTarget(dir, path, posixRules, existsSync, realpathSync)

/** A minimal but real .docx: the contract has to be able to open it. */
async function docxPayload(bodyXml: string): Promise<string> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`,
  )
  return (await zip.generateAsync({ type: 'base64' })) as string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The grant bookkeeping the main process keeps, as a live object. */
class GrantStore {
  dir: string
  allocated = new Set<string>()
  batch: string
  released = false
  tornDown = false

  constructor(dir: string, batch: string) {
    this.dir = dir
    this.batch = batch
  }

  grant(): MailMergeGrant | undefined {
    if (this.released || this.tornDown) return undefined
    return { dir: this.dir, allocated: this.allocated, batch: this.batch }
  }

  /** exactly what the handler passes as `isAuthorized` */
  live(batch: string): boolean {
    return !this.released && !this.tornDown && this.batch === batch
  }

  release() {
    this.released = true
  }

  /** the user picked the same folder again: a new batch owns it */
  rePick(batch: string) {
    this.released = false
    this.batch = batch
    this.allocated = new Set<string>()
  }
}

describe('a released grant cannot commit a write', () => {
  it('refuses a batch whose grant was released while it was preparing the file', async () => {
    const dir = await freshDir()
    const store = new GrantStore(dir, 'batch-1')
    // the second authorization check is the one that matters: the grant was live
    // when the request was accepted and gone by the time the file is committed
    let checks = 0
    const result = await commitMailMergeWrite(
      store.grant(),
      dir,
      'Huy.docx',
      await docxPayload('<w:p><w:r><w:t>Dear Huy</w:t></w:r></w:p>'),
      'overwrite',
      contained,
      { isAuthorized: () => ++checks === 1 },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no longer authorized')
    expect(await listing(dir)).toEqual([])
  })

  it('refuses a write released during lazy-media materialisation', async () => {
    const dir = await freshDir()
    const store = new GrantStore(dir, 'batch-1')
    const payload = await docxPayload('<w:p><w:r><w:t>Dear Huy</w:t></w:r></w:p>')
    const inFlight = commitMailMergeWrite(
      store.grant(),
      dir,
      'Huy.docx',
      payload,
      'overwrite',
      contained,
      {
        materialize: async (bytes) => {
          await sleep(30)
          return bytes
        },
        isAuthorized: () => store.live('batch-1'),
      },
    )
    // the user cancels the batch and closes the dialog while the media is being
    // spliced back in
    setTimeout(() => store.release(), 10)
    const result = await inFlight
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no longer authorized')
    expect(await listing(dir)).toEqual([])
  })

  it('refuses an in-flight write when the same folder is picked again by a new batch', async () => {
    const dir = await freshDir()
    const store = new GrantStore(dir, 'batch-1')
    const payload = await docxPayload('<w:p><w:r><w:t>Dear Huy</w:t></w:r></w:p>')
    const inFlight = commitMailMergeWrite(
      store.grant(),
      dir,
      'Huy.docx',
      payload,
      'overwrite',
      contained,
      {
        materialize: async (bytes) => {
          await sleep(30)
          return bytes
        },
        isAuthorized: () => store.live('batch-1'),
      },
    )
    // release, then choose the identical directory for a second batch: matching
    // the directory string alone would let the cancelled batch write into it
    setTimeout(() => {
      store.release()
      store.rePick('batch-2')
    }, 10)
    const result = await inFlight
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no longer authorized')
    expect(await listing(dir)).toEqual([])
  })

  it('keeps a file that already committed when the batch is cancelled afterwards', async () => {
    const dir = await freshDir()
    const store = new GrantStore(dir, 'batch-1')
    const first = await commitMailMergeWrite(
      store.grant(),
      dir,
      '1_Huy.docx',
      await docxPayload('<w:p><w:r><w:t>Dear Huy</w:t></w:r></w:p>'),
      'rename',
      contained,
      { isAuthorized: () => store.live('batch-1') },
    )
    expect(first.ok).toBe(true)
    store.release()
    const second = await commitMailMergeWrite(
      store.grant(),
      dir,
      '2_An.docx',
      await docxPayload('<w:p><w:r><w:t>Dear An</w:t></w:r></w:p>'),
      'rename',
      contained,
      { isAuthorized: () => store.live('batch-1') },
    )
    expect(second.ok).toBe(false)
    // the recipient that finished keeps its document: cancellation stops the
    // batch, it does not undo work the user already received
    expect(await listing(dir)).toEqual(['1_Huy.docx'])
  })

  it('lets a second batch write into the same directory after the first one released it', async () => {
    const dir = await freshDir()
    const store = new GrantStore(dir, 'batch-1')
    await commitMailMergeWrite(
      store.grant(),
      dir,
      '1_Huy.docx',
      await docxPayload('<w:p><w:r><w:t>Dear Huy</w:t></w:r></w:p>'),
      'rename',
      contained,
      { isAuthorized: () => store.live('batch-1') },
    )
    store.release()
    store.rePick('batch-2')
    const result = await commitMailMergeWrite(
      store.grant(),
      dir,
      '2_An.docx',
      await docxPayload('<w:p><w:r><w:t>Dear An</w:t></w:r></w:p>'),
      'rename',
      contained,
      { isAuthorized: () => store.live('batch-2') },
    )
    expect(result.ok).toBe(true)
    expect(await listing(dir)).toEqual(['1_Huy.docx', '2_An.docx'])
  })

  it('refuses a request from a tab that has been torn down', async () => {
    const dir = await freshDir()
    const store = new GrantStore(dir, 'batch-1')
    store.tornDown = true
    const result = await commitMailMergeWrite(
      store.grant(),
      dir,
      'Huy.docx',
      await docxPayload('<w:p><w:r><w:t>Dear Huy</w:t></w:r></w:p>'),
      'overwrite',
      contained,
      { isAuthorized: () => store.live('batch-1') },
    )
    expect(result.ok).toBe(false)
    expect(await listing(dir)).toEqual([])
  })
})

describe('the finished file is still bounded', () => {
  it('refuses a materialised document larger than the output ceiling', async () => {
    const dir = await freshDir()
    const store = new GrantStore(dir, 'batch-1')
    const payload = await docxPayload('<w:p><w:r><w:t>Dear Huy</w:t></w:r></w:p>')
    const result = await commitMailMergeWrite(
      store.grant(),
      dir,
      'Huy.docx',
      payload,
      'overwrite',
      contained,
      {
        // restoring the pictures can make the file bigger than the slim payload
        // the renderer sent; that growth is capped, not waved through
        materialize: (bytes) =>
          Promise.resolve(Buffer.concat([bytes, Buffer.alloc(MAX_MAIL_MERGE_OUTPUT_BYTES)])),
        isAuthorized: () => store.live('batch-1'),
      },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('larger than')
    expect(await listing(dir)).toEqual([])
  })

  it('accepts a materialised document that grows within the ceiling', async () => {
    const dir = await freshDir()
    const store = new GrantStore(dir, 'batch-1')
    const payload = await docxPayload('<w:p><w:r><w:t>Dear Huy</w:t></w:r></w:p>')
    const result = await commitMailMergeWrite(
      store.grant(),
      dir,
      'Huy.docx',
      payload,
      'overwrite',
      contained,
      {
        materialize: (bytes) => Promise.resolve(Buffer.concat([bytes, Buffer.alloc(1024)])),
        isAuthorized: () => store.live('batch-1'),
      },
    )
    expect(result.ok).toBe(true)
    expect((await readdir(dir))[0]).toBe('Huy.docx')
  })

  it('refuses an oversized payload on its encoded length, before decoding it', () => {
    // a string this long is rejected by character count: no Buffer of that size
    // is ever allocated just to discover the payload is too big
    const huge = 'a'.repeat(MAX_MAIL_MERGE_PAYLOAD_BYTES * 4)
    const dir = freshDirSync()
    const decision = decideMailMergeWrite(
      { dir, allocated: new Set<string>(), batch: 'batch-1' },
      dir,
      'Huy.docx',
      huge,
      'overwrite',
      contained,
    )
    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('the oversized payload should have been refused')
    expect(decision.error).toContain('larger than')
    expect(readdirSync(dir)).toEqual([])
  })
})
