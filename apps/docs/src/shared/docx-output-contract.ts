import JSZip from 'jszip'
import {
  assertZipInflatesWithinLimits,
  assertZipWithinLimits,
  fieldInstructionsInXml,
} from '@genoffice/docx-engine'

/**
 * The contract a merged .docx has to satisfy before it reaches the disk.
 *
 * "saveDocx did not throw" is not the same as "the merge worked". Header and
 * footer parts the user never opened in the header editor, footnote and endnote
 * bodies, and the text inside a textbox are copied from the template byte-for-byte:
 * a MERGEFIELD inside one of them survives into every output file, and Word then
 * prints «Name» for every recipient. The only honest check is to read the parts
 * the writer is about to store and look for a field the merge did not resolve.
 */
const MERGE_PART_RE = /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/
/** a part larger than this is not a text document we can scan in memory */
const MAX_PART_BYTES = 16 * 1024 * 1024
/** the marker a lazily opened document leaves in place of a picture (see lazy-media.ts) */
export const LAZY_MEDIA_MAGIC = 'GENOFFICE-LAZY-MEDIA'
const MEDIA_PART_RE = /^word\/media\//

export interface MergedDocxCheck {
  ok: boolean
  error?: string
  unresolved: string[]
  /** parts other than word/document.xml — a field there is a template problem,
   *  identical for every recipient, so the batch can stop at the first one */
  templateParts: string[]
}

/**
 * `media: false` skips the placeholder scan. The renderer cannot use the full
 * check: a lazily opened template legitimately carries placeholders until the
 * main process splices the original pictures back in, so rejecting them before
 * the write would refuse a file the writer was about to repair. The main process
 * runs the full check *after* materialisation.
 */
export async function checkMergedDocx(
  bytes: Uint8Array | Buffer,
  options: { media?: boolean } = {},
): Promise<MergedDocxCheck> {
  let zip: JSZip
  try {
    // the same metered gate every other .docx in the app goes through: the
    // declared sizes are checked before anything is inflated, so a zip bomb is
    // refused here instead of turning the scan below into a memory problem
    await assertZipInflatesWithinLimits(bytes)
    zip = await JSZip.loadAsync(bytes)
    assertZipWithinLimits(zip)
  } catch (error) {
    return {
      ok: false,
      error: `the merged file is not a readable .docx: ${String(error)}`,
      unresolved: [],
      templateParts: [],
    }
  }
  const unresolved: string[] = []
  const templateParts: string[] = []
  for (const entry of zip.filter((path) => MERGE_PART_RE.test(path))) {
    let xml: string
    try {
      xml = await entry.async('string')
    } catch (error) {
      return {
        ok: false,
        error: `the merged document part ${entry.name} cannot be read: ${String(error)}`,
        unresolved,
        templateParts,
      }
    }
    if (xml.length > MAX_PART_BYTES) {
      return {
        ok: false,
        error: `the merged document part ${entry.name} is too large to verify`,
        unresolved,
        templateParts,
      }
    }
    for (const instr of fieldInstructionsInXml(xml)) {
      const trimmed = instr.trim()
      if (/^\s*(MERGEFIELD|IF|NEXT|SKIPIF)\b/i.test(trimmed) && !unresolved.includes(trimmed)) {
        unresolved.push(trimmed)
        if (entry.name !== 'word/document.xml' && !templateParts.includes(entry.name)) {
          templateParts.push(entry.name)
        }
      }
    }
  }
  if (unresolved.length > 0) {
    return {
      ok: false,
      error: `the merged document still contains field(s) the merge cannot resolve: ${unresolved.join(', ')}`,
      unresolved,
      templateParts,
    }
  }
  // a lazily opened template keeps its pictures in the source file and writes a
  // placeholder into the saved bytes. A merged file is a brand-new package with
  // no source to point at, so an unmaterialised placeholder is a broken picture.
  if (options.media !== false) {
    for (const entry of zip.filter((path) => MEDIA_PART_RE.test(path))) {
      let raw: Buffer
      try {
        raw = await entry.async('nodebuffer')
      } catch {
        return {
          ok: false,
          error: `the merged document's media part ${entry.name} cannot be read`,
          unresolved,
          templateParts,
        }
      }
      if (raw.subarray(0, LAZY_MEDIA_MAGIC.length).toString('latin1') === LAZY_MEDIA_MAGIC) {
        return {
          ok: false,
          error: `the merged document could not embed its picture ${entry.name}: the source file is no longer available`,
          unresolved,
          templateParts,
        }
      }
    }
  }
  return { ok: true, unresolved: [], templateParts: [] }
}
