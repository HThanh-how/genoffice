/**
 * Honest transparency for Antigravity pictures. agy's image tool has no alpha channel: whatever the
 * prompt says, the picture comes back as an opaque JPEG. The editors' `transparentBackground`
 * contract is kept by cutting the flat backdrop off locally (the same flood fill as the "remove
 * background" dialogs). When that is not possible the opaque picture is returned unchanged together
 * with a notice, never a picture that merely looks transparent.
 */

import type { MediaBlob } from '@genoffice/ai-provider'
import {
  cutoutGeneratedBackground,
  type CutoutFailure,
  type CutoutOptions,
} from '@genoffice/electron-utils/image-cutout'

export const AGY_NO_ALPHA_NOTICE =
  'Antigravity cannot create transparent images, and the background could not be removed locally'

const REASON_TEXT: Record<CutoutFailure, string> = {
  'no-decoder': 'this process cannot decode pictures',
  'decode-failed': 'the picture could not be decoded',
  'too-large': 'the picture is too large to process',
  'no-background': 'the picture has no plain border to remove',
  'subject-lost': 'removing the border would have erased the subject',
}

export interface AgyTransparencyResult {
  bytes: Uint8Array
  mime: string
  /** true only when the returned bytes are a PNG whose backdrop really is transparent */
  transparent: boolean
  /** why the picture stayed opaque; absent when transparent */
  notice?: string
}

export async function makeAgyImageTransparent(
  image: MediaBlob,
  options?: CutoutOptions,
): Promise<AgyTransparencyResult> {
  const outcome = await cutoutGeneratedBackground(image.bytes, options)
  if (outcome.ok) return { bytes: outcome.png, mime: 'image/png', transparent: true }
  return {
    bytes: image.bytes,
    mime: image.mime,
    transparent: false,
    notice: `${AGY_NO_ALPHA_NOTICE} (${REASON_TEXT[outcome.reason]}); the picture keeps its plain background.`,
  }
}
