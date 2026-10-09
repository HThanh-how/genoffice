import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { AGY_DEFAULT_MODEL, runAgy } from './agy-cli'
import { agyTruncatedError } from './agy-errors'
import type { AgyRunOptions, AgyRunResult, AgyStagedFile } from './agy-cli'
import type { GenerateImageInput, MediaBlob } from './media-protocols'
import type { AiMediaProviderConfig } from './types'

/**
 * Image generation through the local Antigravity agent. Node-only: imported from main-process
 * code (media-protocols.ts), never from a renderer-reachable file (see agy-browser-safety.test.ts).
 *
 * How it works (verified against agy on Windows, 2026-10): the agent has a built-in image tool
 * but only uses it when told so explicitly; a plain prompt makes it try a shell command, which the
 * headless sandbox denies (empty response + `denied_actions`). The tool saves the picture OUTSIDE
 * our staging directory, under `<home>/.gemini/antigravity-cli/brain/<conversation_id>/`, and the
 * reply text names the path.
 *
 * Since agy 1.2.16 the tool is an `image-generator` subagent that writes the prompt, checks every
 * result and makes up to three attempts, so one request may leave several pictures behind. Re-checked
 * on macOS with agy 1.3.2 (2026-10): the reply names the final file (`[name.jpg](file:///…/brain/<id>/name.jpg)`),
 * the picture is a 1024x1024 JPEG (never alpha) and a plain one-image prompt used one attempt. The reply's
 * path wins; the folder scan is the fallback and prefers the newest file.
 *
 * Security: model text is untrusted. A path from the reply is never opened directly; it is
 * realpath-resolved and must live inside the conversation folder of THIS run (UUID taken from the
 * result, folder itself must resolve inside the brain root), carry an image extension, stay under
 * a size cap and start with an image magic number. The agent's own files are never deleted.
 */

export const AGY_IMAGE_MAX_BYTES = 25 * 1024 * 1024
export const AGY_IMAGE_TIMEOUT_MS = 240_000
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PROMPT_CHARS = 4000
const MAX_CANDIDATES = 10
const MAX_SCAN_FILES = 400
const MAX_SCAN_DEPTH = 3
/** files older than the run start (minus filesystem timestamp slack) are not this run's output */
const MTIME_SLACK_MS = 5_000
/** agy mirrors every attachment (our staged reference pictures) here; those are inputs, never output */
const ATTACHMENT_MIRROR_DIRS = new Set(['.tempmediaStorage'])

export function isAgyConversationId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

type PathFlavor = typeof win32

function flavor(platform: NodeJS.Platform): PathFlavor {
  return platform === 'win32' ? win32 : (posix as unknown as PathFlavor)
}

/** `<home>/.gemini/antigravity-cli/brain`: the same relative layout on every platform. */
export function agyBrainRoot(home: string, platform: NodeJS.Platform): string {
  return flavor(platform).join(home, '.gemini', 'antigravity-cli', 'brain')
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const ASPECT_WORDS: Record<string, string> = {
  '1:1': 'a square image (1:1 aspect ratio)',
  '4:3': 'a landscape image (4:3 aspect ratio)',
  '3:4': 'a portrait image (3:4 aspect ratio)',
  '3:2': 'a landscape image (3:2 aspect ratio)',
  '2:3': 'a portrait image (2:3 aspect ratio)',
  '16:9': 'a wide landscape image (16:9 aspect ratio)',
  '9:16': 'a tall portrait image (9:16 aspect ratio)',
}

/** The explicit-tool prompt. Size and background hints go in words; the tool has no parameters for them. */
export function buildAgyImagePrompt(
  input: Pick<GenerateImageInput, 'prompt' | 'aspectRatio' | 'transparent'>,
  referenceNames: string[] = [],
): string {
  const description = input.prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_CHARS)
  const aspect = input.aspectRatio ? ASPECT_WORDS[input.aspectRatio.trim()] : undefined
  const hints: string[] = ['Generate one image only.']
  if (aspect) hints.push(`Make it ${aspect}.`)
  if (input.transparent) {
    // the tool has no alpha: the picture comes back opaque and the caller cuts this backdrop off locally
    hints.push(
      'Show the subject isolated on a plain, uniform, flat white background, with no shadow, gradient, border or texture behind it.',
    )
  }
  if (referenceNames.length > 0) {
    hints.push(
      `Use the attached image file(s) in the current directory (${referenceNames.join(', ')}) as visual reference.`,
    )
  }
  return (
    'Use your built-in image generation tool (do not write or run any code or shell commands) ' +
    `to generate ${description}${/[.!?]$/.test(description) ? '' : '.'} ` +
    (hints.length ? `${hints.join(' ')} ` : '') +
    'Tell me the file path of the generated image.'
  )
}

// ---------------------------------------------------------------------------
// Path extraction + confinement
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const EXT_PATTERN = '(?:png|jpe?g|webp)'

/**
 * Candidate image paths named in the reply (markdown links and file: URLs included). Only a
 * hint list: every candidate is confined before it is opened, so a lying reply cannot widen access.
 */
export function extractAgyImagePaths(
  response: string,
  conversationDir: string,
  platform: NodeJS.Platform,
): string[] {
  const found: string[] = []
  const add = (raw: string) => {
    let value = raw.trim()
    if (/^file:\/\//i.test(value)) {
      value = value.replace(/^file:\/\/\/?/i, '')
      try {
        value = decodeURIComponent(value)
      } catch {
        return
      }
      if (platform !== 'win32') value = `/${value}`
    }
    value = value.replace(/[.,;:]+$/, '')
    if (value && !found.includes(value) && found.length < MAX_CANDIDATES) found.push(value)
  }
  const win = platform === 'win32'
  // 1. anything that continues the expected conversation folder (tolerates spaces in the home path)
  const dirPattern = conversationDir
    .split(/[\\/]+/)
    .map(escapeRegExp)
    .join('[\\\\/]+')
  const prefixed = new RegExp(`${dirPattern}[\\\\/][^\\r\\n"'<>|*?\`]*?\\.${EXT_PATTERN}\\b`, 'gi')
  for (const match of response.matchAll(prefixed)) add(match[0])
  // 2. file: URLs
  for (const match of response.matchAll(
    new RegExp(`file:\\/\\/[^\\s)"'<>\`]+?\\.${EXT_PATTERN}\\b`, 'gi'),
  )) {
    add(match[0])
  }
  // 3. generic absolute paths (these almost always fail confinement when the reply lied)
  const generic = win
    ? new RegExp(`[A-Za-z]:[\\\\/][^\\s"'<>|*?\`()\\[\\]]+?\\.${EXT_PATTERN}\\b`, 'gi')
    : new RegExp(`\\/[^\\s"'<>|*?\`()\\[\\]]+?\\.${EXT_PATTERN}\\b`, 'gi')
  for (const match of response.matchAll(generic)) add(match[0])
  return found
}

export interface AgyImageFs {
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ isFile(): boolean; size: number; mtimeMs: number }>
  readFile(path: string): Promise<Uint8Array>
  /** regular files below `dir` (symlinks are not followed), depth- and count-limited */
  listFiles(dir: string): Promise<string[]>
}

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCAN_FILES) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_FILES) return
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) await walk(full, depth + 1, out)
    else if (entry.isFile()) out.push(full)
  }
}

export const realAgyImageFs: AgyImageFs = {
  realpath: (path) => realpath(path),
  stat: (path) => stat(path),
  readFile: (path) => readFile(path),
  listFiles: async (dir) => {
    const out: string[] = []
    await walk(dir, 0, out)
    return out
  },
}

function isInside(root: string, target: string, path: PathFlavor): boolean {
  const rel = path.relative(root, target)
  if (!rel || path.isAbsolute(rel)) return false
  return rel.split(/[\\/]/)[0] !== '..'
}

export interface AgyImageLocation {
  home: string
  platform: NodeJS.Platform
}

/**
 * Resolve `candidate` and prove it is an image file of this run's conversation folder. Returns the
 * real path; throws otherwise. The conversation folder must itself resolve inside the brain root,
 * so a symlinked folder cannot redirect the read.
 */
export async function confineAgyImagePath(
  candidate: string,
  conversationId: string,
  location: AgyImageLocation,
  fs: AgyImageFs = realAgyImageFs,
): Promise<string> {
  if (!isAgyConversationId(conversationId)) throw new Error('Invalid Antigravity conversation id')
  const path = flavor(location.platform)
  if (!candidate || candidate.includes('\0') || !path.isAbsolute(candidate)) {
    throw new Error('Image path is not absolute')
  }
  const brainRoot = agyBrainRoot(location.home, location.platform)
  const realBrain = await fs.realpath(brainRoot)
  const realConversation = await fs.realpath(path.join(brainRoot, conversationId))
  if (!isInside(realBrain, realConversation, path)) {
    throw new Error('Antigravity conversation folder resolves outside its working directory')
  }
  const realFile = await fs.realpath(candidate)
  if (!isInside(realConversation, realFile, path)) {
    throw new Error('Image path is outside the Antigravity conversation folder')
  }
  if (!IMAGE_EXTENSIONS.has(path.extname(realFile).toLowerCase())) {
    throw new Error('Image file type is not allowed')
  }
  const info = await fs.stat(realFile)
  if (!info.isFile()) throw new Error('Image path is not a file')
  if (info.size <= 0 || info.size > AGY_IMAGE_MAX_BYTES) {
    throw new Error('Generated image is empty or larger than 25 MB')
  }
  return realFile
}

/** MIME from the leading magic bytes; undefined when it is not png/jpeg/webp. */
export function sniffAgyImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Result interpretation + entry point
// ---------------------------------------------------------------------------

export const AGY_IMAGE_FAILURE = 'Antigravity could not generate the image.'

/**
 * The image subagent reports its own failures in the reply (verified on agy 1.3.2: HTTP 429
 * RESOURCE_EXHAUSTED from the image model after a "no image generated" first attempt). Those are
 * transient capacity limits, not a prompt problem, so they get their own wording.
 */
const RATE_LIMIT_REPLY = /\b429\b|rate.?limit|resource.?exhausted|too many requests|quota|capacity/i

/** Actionable error for "no image came out" (empty reply, sandbox refusal, text-only answer). */
export function agyImageFailureMessage(
  result: Pick<AgyRunResult, 'text' | 'deniedActions'>,
): string {
  const denied = (result.deniedActions ?? []).map((d) => d.displayName || d.action).filter(Boolean)
  const text = result.text.replace(/\s+/g, ' ').trim()
  if (denied.length === 0 && RATE_LIMIT_REPLY.test(text)) {
    return (
      `${AGY_IMAGE_FAILURE} Antigravity's image model is rate limited or out of quota right now ` +
      '(HTTP 429). Wait a few minutes and try again, or choose another provider under ' +
      'Settings → AI Media & Search.'
    )
  }
  const detail =
    denied.length > 0
      ? ` The agent tried to use ${[...new Set(denied)].join(', ')}, which the headless sandbox denies instead of its image tool.`
      : text
        ? ` It replied without an image: ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`
        : ' It returned an empty reply.'
  return (
    `${AGY_IMAGE_FAILURE}${detail} Try again or rephrase the request, or choose another ` +
    'provider under Settings → AI Media & Search.'
  )
}

export interface AgyImageDeps {
  run?: (options: AgyRunOptions) => Promise<AgyRunResult>
  fs?: AgyImageFs
  home?: string
  platform?: NodeJS.Platform
  now?: () => number
}

function stagedReferences(references: MediaBlob[] | undefined): AgyStagedFile[] {
  const files: AgyStagedFile[] = []
  for (const blob of (references ?? []).slice(0, 4)) {
    if (!blob.mime.startsWith('image/')) continue
    const sub = blob.mime.split('/')[1]?.toLowerCase() ?? 'png'
    const ext = sub === 'jpeg' ? 'jpg' : /^(png|jpg|webp|gif)$/.test(sub) ? sub : 'png'
    files.push({ name: `reference-${files.length + 1}.${ext}`, bytes: blob.bytes })
  }
  return files
}

async function readConfined(
  path: string,
  fs: AgyImageFs,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const bytes = await fs.readFile(path)
  if (bytes.byteLength > AGY_IMAGE_MAX_BYTES) throw new Error('Generated image is too large')
  const mime = sniffAgyImageMime(bytes)
  if (!mime) throw new Error('File is not a PNG, JPEG or WebP image')
  return { bytes, mime }
}

/**
 * Generate one image with the user's Antigravity agent. Returns the same MediaBlob the HTTP image
 * providers return, so the existing save / insert flows are unchanged.
 */
export async function generateImageWithAgy(
  config: AiMediaProviderConfig,
  input: GenerateImageInput,
  signal?: AbortSignal,
  deps: AgyImageDeps = {},
): Promise<MediaBlob> {
  const fs = deps.fs ?? realAgyImageFs
  const location: AgyImageLocation = {
    home: deps.home ?? homedir(),
    platform: deps.platform ?? process.platform,
  }
  const now = deps.now ?? Date.now
  const run = deps.run ?? ((options: AgyRunOptions) => runAgy(options))
  const files = stagedReferences(input.references)
  const startedAt = now()
  const result = await run({
    cliPath: config.cliPath?.trim() || undefined,
    model: config.imageModel?.trim() || AGY_DEFAULT_MODEL,
    prompt: buildAgyImagePrompt(
      input,
      files.map((f) => f.name),
    ),
    files,
    signal,
    timeoutMs: AGY_IMAGE_TIMEOUT_MS,
    task: 'image',
    // A run cut off by --print-timeout may still have saved the picture: look for it, and only
    // report the time-out when nothing usable is there (the file itself is validated below).
    allowPartial: true,
  })
  const conversationId = result.conversationId
  if (!isAgyConversationId(conversationId)) {
    throw result.truncated
      ? agyTruncatedError(result.text)
      : new Error(agyImageFailureMessage(result))
  }
  const path = flavor(location.platform)
  const conversationDir = path.join(agyBrainRoot(location.home, location.platform), conversationId)

  // 1. paths the reply names (each one confined before it is read)
  const named = extractAgyImagePaths(result.text, conversationDir, location.platform)
  for (const candidate of named) {
    try {
      const real = await confineAgyImagePath(candidate, conversationId, location, fs)
      const { bytes, mime } = await readConfined(real, fs)
      return { bytes, mime, name: path.basename(real) }
    } catch {
      /* a path the model got wrong, or lied about: try the next one, then the folder scan */
    }
  }
  // 2. images the agent wrote into its conversation folder during this run
  let scanned: string[] = []
  try {
    scanned = await fs.listFiles(await fs.realpath(conversationDir))
  } catch {
    /* folder missing: nothing was generated */
  }
  const fresh: Array<{ file: string; mtimeMs: number }> = []
  for (const file of scanned) {
    if (!IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue
    if (file.split(/[\\/]/).some((part) => ATTACHMENT_MIRROR_DIRS.has(part))) continue
    try {
      const real = await confineAgyImagePath(file, conversationId, location, fs)
      const info = await fs.stat(real)
      if (info.mtimeMs >= startedAt - MTIME_SLACK_MS)
        fresh.push({ file: real, mtimeMs: info.mtimeMs })
    } catch {
      /* skip */
    }
  }
  fresh.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const { file } of fresh) {
    try {
      const { bytes, mime } = await readConfined(file, fs)
      return { bytes, mime, name: path.basename(file) }
    } catch {
      /* try the next newest */
    }
  }
  throw result.truncated
    ? agyTruncatedError(result.text)
    : new Error(agyImageFailureMessage(result))
}
