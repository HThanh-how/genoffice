/**
 * The main process' mail-merge commit pipeline.
 *
 * One request for one file. The order of the steps is the whole point:
 *
 *   1. authorize the batch and its destination (no filesystem access yet),
 *   2. restore the media a lazily opened template left as placeholders,
 *   3. verify the finished document against the output contract,
 *   4. re-check that the batch still holds the grant it was authorized with,
 *   5. write.
 *
 * Steps 2 and 3 are asynchronous. A user who cancels the batch, closes the
 * dialog or picks a different folder while they are running has released the
 * grant, and a write that commits afterwards would put a file in a directory
 * the tab no longer owns. `isAuthorized` is therefore asked again immediately
 * before the file is opened, and once more after the write has started.
 *
 * A write that already committed is never undone: the batch owns only the file
 * it created, and deleting it on a later cancellation would destroy a document
 * the user asked for.
 */
import { checkMergedDocx } from './docx-output-contract'
import {
  decideMailMergeWrite,
  MAX_MAIL_MERGE_OUTPUT_BYTES,
  type MailMergeGrant,
} from './mail-merge-ipc'
import { writeMailMergeOutput } from './mail-merge-write'

export interface MailMergeCommitOptions {
  /** restore lazy-media placeholders; omitted when the environment has no lazy media */
  materialize?: (bytes: Buffer) => Promise<Buffer>
  /** is this batch's grant still live? asked before and after every await */
  isAuthorized: () => boolean
}

export interface MailMergeCommitResult {
  ok: boolean
  path?: string
  name?: string
  error?: string
  skipped?: boolean
}

export async function commitMailMergeWrite(
  grant: MailMergeGrant | undefined,
  dir: unknown,
  name: unknown,
  base64: unknown,
  overwrite: unknown,
  contained: (dir: string, path: string) => string | null,
  options: MailMergeCommitOptions,
): Promise<MailMergeCommitResult> {
  // every check — directory, name, extension, payload, policy, containment —
  // happens before a single byte is written, so a refused request creates
  // nothing on disk
  const decision = decideMailMergeWrite(grant, dir, name, base64, overwrite, contained)
  if (!decision.ok) return { ok: false, error: decision.error }
  if (!options.isAuthorized()) {
    return { ok: false, error: 'output directory is no longer authorized' }
  }
  try {
    const isDocx = /\.docx$/i.test(decision.name)
    // a template opened lazily keeps its pictures in the source file and writes
    // `lazy://<hash>/word/media/…` placeholders into the saved bytes. A merged
    // document is a brand-new file with no source to point at, so the media has
    // to be spliced back in exactly as a normal save does — otherwise every
    // merged document is a .docx with broken images.
    let data = decision.payload
    if (isDocx && options.materialize) {
      try {
        data = await options.materialize(decision.payload)
      } catch (error) {
        // the placeholders name a source file that is gone: the merged document
        // would open with a broken picture, so the recipient gets no file at all
        return {
          ok: false,
          error: `the merged document could not embed its picture: ${String(error)}`,
        }
      }
    }
    // materialisation can legitimately produce more bytes than the slim payload
    // the renderer sent; the ceiling is the same one the source file was read
    // under, so restoring media cannot smuggle an unbounded file past the
    // payload limit
    if (data.length > MAX_MAIL_MERGE_OUTPUT_BYTES) {
      return { ok: false, error: 'the finished file is larger than a merge document can be' }
    }
    if (isDocx) {
      const contract = await checkMergedDocx(data)
      if (!contract.ok) return { ok: false, error: contract.error }
    }
    // materialisation and verification crossed two awaits. The renderer can
    // cancel the batch and release the grant during either of them, so the
    // authorization is re-checked immediately before the write is committed.
    if (!options.isAuthorized()) {
      return { ok: false, error: 'output directory is no longer authorized' }
    }
    // the writer is the authority on the final name: the renderer's proposal may
    // have been sanitized, shortened or renamed by this point, and each
    // candidate it produces is re-contained before it is opened
    const outcome = await writeMailMergeOutput(
      decision.dir,
      decision.name,
      data,
      decision.policy,
      decision.allocated,
      decision.resolvePath,
    )
    if (outcome.skipped) return { ok: false, skipped: true, path: outcome.path, name: outcome.name }
    return { ok: true, path: outcome.path, name: outcome.name }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}
