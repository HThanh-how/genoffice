import {
  AGY_DEFAULT_MODEL,
  AGY_MAX_FILE_BYTES,
  AGY_MAX_FILES,
  listAgyModels,
  runAgy,
} from './agy-cli'
import type { AgyRunOptions, AgyRunResult, AgyStagedFile } from './agy-cli'
import type { AnalyzeMediaInput, MediaBlob } from './media-protocols'
import type { AiMediaProviderConfig } from './types'

/**
 * Media analysis (images, short video, audio) and the free connection test through the local
 * Antigravity agent. Node-only like agy-cli.ts: main-process code only.
 *
 * Verified with agy on Windows (2026-10): a png, a 3 s mp4 and a wav staged in the working
 * directory are read when the prompt names the file (about 10 s, 15-30k input tokens each).
 */

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
}

function extensionOf(blob: MediaBlob): string | undefined {
  const mime = blob.mime.split(';')[0]!.trim().toLowerCase()
  const known = MIME_EXTENSIONS[mime]
  if (known) return known
  const fromName = /\.([A-Za-z0-9]{2,5})$/.exec(blob.name ?? '')?.[1]?.toLowerCase()
  return fromName &&
    /^(png|jpe?g|webp|gif|mp4|mov|webm|mkv|mp3|wav|m4a|aac|ogg|flac)$/.test(fromName)
    ? fromName
    : undefined
}

/** Staged file list + prompt for one analysis request. Throws a readable error for unusable input. */
export function buildAgyMediaPlan(input: AnalyzeMediaInput): {
  prompt: string
  files: AgyStagedFile[]
} {
  if (input.media.length === 0) throw new Error('No media to analyze')
  if (input.media.length > AGY_MAX_FILES) {
    throw new Error(`Antigravity can analyze at most ${AGY_MAX_FILES} files at a time`)
  }
  const files: AgyStagedFile[] = []
  const counters: Record<string, number> = {}
  for (const blob of input.media) {
    const kind = blob.mime.split('/')[0]
    const ext = extensionOf(blob)
    if (!ext || (kind !== 'image' && kind !== 'video' && kind !== 'audio')) {
      throw new Error(
        `Antigravity cannot read ${blob.mime || 'this'} media (images, video and audio only)`,
      )
    }
    if (blob.bytes.byteLength > AGY_MAX_FILE_BYTES) {
      throw new Error(
        `This ${kind} is larger than ${AGY_MAX_FILE_BYTES / 1024 / 1024} MB, the most Antigravity accepts`,
      )
    }
    counters[kind] = (counters[kind] ?? 0) + 1
    files.push({ name: `${kind}-${counters[kind]}.${ext}`, bytes: blob.bytes })
  }
  const prompt =
    'You are analyzing media files for a desktop office suite through a plain text channel. ' +
    'Do not run shell commands, browse the web or modify any file; reply with text only. ' +
    `The media files are in the current directory: ${files.map((f) => f.name).join(', ')}. ` +
    'Open and examine every file (look at images and video frames, listen to audio) before answering.\n\n' +
    `Task:\n${input.requirements.trim()}\n\n` +
    'Answer in the language of the task above and describe only what the files actually contain.'
  return { prompt, files }
}

export interface AgyMediaDeps {
  run?: (options: AgyRunOptions) => Promise<AgyRunResult>
}

export async function analyzeMediaWithAgy(
  config: AiMediaProviderConfig,
  input: AnalyzeMediaInput,
  signal?: AbortSignal,
  deps: AgyMediaDeps = {},
): Promise<string> {
  const plan = buildAgyMediaPlan(input)
  const run = deps.run ?? ((options: AgyRunOptions) => runAgy(options))
  const result = await run({
    cliPath: config.cliPath?.trim() || undefined,
    model: config.analysisModel?.trim() || AGY_DEFAULT_MODEL,
    prompt: plan.prompt,
    files: plan.files,
    signal,
  })
  if (!result.text.trim()) throw new Error('Antigravity CLI returned no content')
  return result.text
}

/** Settings "Test connection": `agy models` (no model call, no quota). */
export async function testAgyMediaProvider(
  config: AiMediaProviderConfig,
): Promise<{ ok: boolean; error?: string }> {
  const catalog = await listAgyModels(config.cliPath?.trim() || undefined, undefined, {
    force: true,
  })
  if (catalog.error) return { ok: false, error: catalog.error }
  return catalog.models.length > 0
    ? { ok: true }
    : { ok: false, error: 'Antigravity CLI returned no models. Are you signed in?' }
}
