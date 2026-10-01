import { opendir, stat } from 'node:fs/promises'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, parse, resolve } from 'node:path'

const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024
const MAX_ROOT_LENGTH = 32_768
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  'node_modules',
  'build',
  'coverage',
  'dist',
  'venv',
])
const SUPPORTED_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.csv',
  '.tsv',
  '.ppt',
  '.pptx',
  '.pdf',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.txt',
])

export interface FolderScanStatus {
  state?: 'running' | 'complete' | 'stopped'
  running: boolean
  root?: string
  discovered: number
  enrolled: number
  skipped: number
  errors: number
  lastError?: string
}

export interface DiscoveredDocumentIndexer {
  indexDiscoveredFile(path: string): boolean
}

interface ScanJob {
  root: string
  state: 'running' | 'complete' | 'stopped'
  discovered: number
  enrolled: number
  skipped: number
  errors: number
  lastError?: string
}

interface Manifest {
  version: 1
  jobs: ScanJob[]
}

/** Recursively enroll supported documents found under explicitly selected folders. */
export class FolderScanManager {
  private readonly manifestPath: string
  private readonly memory: DiscoveredDocumentIndexer
  private manifest: Manifest
  private activeRoot: string | null = null
  private stopRequested = false
  private closed = false
  private runner: Promise<void> | null = null

  constructor(userData: string, memory: DiscoveredDocumentIndexer) {
    mkdirSync(userData, { recursive: true })
    this.manifestPath = resolve(userData, 'document-memory-folders.json')
    this.memory = memory
    this.manifest = readManifest(this.manifestPath)
    const interrupted = this.manifest.jobs.find((job) => job.state === 'running')
    if (interrupted) {
      // Traversal restarts at the selected root. Reset traversal counters so they
      // describe this resumed pass instead of counting the same files twice.
      interrupted.discovered = 0
      interrupted.enrolled = 0
      interrupted.skipped = 0
      interrupted.errors = 0
      delete interrupted.lastError
      this.save()
      queueMicrotask(() => this.resume(interrupted.root))
    }
  }

  /** Start or resume scanning one selected folder. */
  start(root: string): FolderScanStatus {
    const normalizedRoot = validateRoot(root)
    if (this.closed) throw new Error('Folder scanner is closed')
    if (this.activeRoot) {
      if (this.activeRoot === normalizedRoot) return this.status()
      throw new Error('A folder scan is already running')
    }

    let job = this.manifest.jobs.find((entry) => entry.root === normalizedRoot)
    if (!job) {
      job = {
        root: normalizedRoot,
        state: 'running',
        discovered: 0,
        enrolled: 0,
        skipped: 0,
        errors: 0,
      }
      this.manifest.jobs.push(job)
    } else if (job.state !== 'running') {
      job.state = 'running'
      job.discovered = 0
      job.enrolled = 0
      job.skipped = 0
      job.errors = 0
      delete job.lastError
    }
    this.save()
    this.run(job)
    return this.status()
  }

  /** Alias used by callers that phrase the action as a scan. */
  scan(root: string): FolderScanStatus {
    return this.start(root)
  }

  stop(): FolderScanStatus {
    this.stopRequested = true
    if (this.activeRoot) {
      const job = this.jobFor(this.activeRoot)
      if (job?.state === 'running') {
        job.state = 'stopped'
        this.save()
      }
    }
    return this.status()
  }

  status(): FolderScanStatus {
    const job = this.activeRoot
      ? this.jobFor(this.activeRoot)
      : this.manifest.jobs[this.manifest.jobs.length - 1]
    return {
      state: job?.state,
      running: !!this.activeRoot,
      ...(job ? { root: job.root } : {}),
      discovered: job?.discovered ?? 0,
      enrolled: job?.enrolled ?? 0,
      skipped: job?.skipped ?? 0,
      errors: job?.errors ?? 0,
      ...(job?.lastError ? { lastError: job.lastError } : {}),
    }
  }

  close(): void {
    this.closed = true
    this.stopRequested = true
  }

  private resume(root: string): void {
    if (this.closed || this.activeRoot) return
    const job = this.jobFor(root)
    if (job?.state !== 'running') return
    try {
      job.root = validateRoot(root)
      this.run(job)
    } catch (error) {
      job.state = 'stopped'
      job.errors++
      job.lastError = error instanceof Error ? error.message : 'The selected folder is unavailable.'
      this.save()
    }
  }

  private run(job: ScanJob): void {
    this.activeRoot = job.root
    this.stopRequested = false
    this.runner = this.walk(job)
      .catch((error: unknown) => {
        job.state = 'stopped'
        job.errors++
        job.lastError = error instanceof Error ? error.message : 'Folder scan failed.'
      })
      .finally(() => {
        this.activeRoot = null
        this.runner = null
        this.save()
      })
  }

  private async walk(job: ScanJob): Promise<void> {
    const pending = [job.root]
    const visitedDirectories = new Set<string>()
    while (pending.length && !this.closed && !this.stopRequested) {
      const directory = pending.pop()!
      const canonical = resolve(directory)
      if (visitedDirectories.has(canonical)) continue
      visitedDirectories.add(canonical)
      let handle
      try {
        handle = await opendir(canonical)
      } catch (error) {
        this.recordError(job, error)
        this.save()
        continue
      }

      try {
        for await (const entry of handle) {
          if (this.closed || this.stopRequested) break
          const path = resolve(canonical, entry.name)
          if (entry.isSymbolicLink()) {
            job.skipped++
            continue
          }
          if (entry.isDirectory()) {
            if (shouldSkipDirectory(entry.name)) job.skipped++
            else pending.push(path)
            continue
          }
          if (!entry.isFile() || entry.name.startsWith('.')) {
            job.skipped++
            continue
          }
          if (!SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
            job.skipped++
            continue
          }
          job.discovered++
          try {
            const fileStat = await stat(path)
            if (this.closed || this.stopRequested) break
            if (!fileStat.isFile()) {
              job.skipped++
            } else if (fileStat.size > MAX_DOCUMENT_BYTES) {
              job.skipped++
            } else if (this.memory.indexDiscoveredFile(path)) {
              job.enrolled++
            }
          } catch (error) {
            this.recordError(job, error)
          }
        }
      } catch (error) {
        this.recordError(job, error)
      } finally {
        await handle.close().catch(() => undefined)
      }
      // Saving after each directory bounds restart replay while keeping traversal off
      // Electron's main event loop. Enrollment itself is idempotent in SQLite.
      this.save()
    }
    if (!this.stopRequested && !this.closed && pending.length === 0) {
      job.state = 'complete'
      this.save()
    }
  }

  private recordError(job: ScanJob, error: unknown): void {
    job.errors++
    job.lastError = error instanceof Error ? error.message : 'Unable to read a folder entry.'
  }

  private jobFor(root: string): ScanJob | undefined {
    return this.manifest.jobs.find((job) => job.root === root)
  }

  private save(): void {
    saveManifest(this.manifestPath, this.manifest)
  }
}

function validateRoot(root: string): string {
  if (
    typeof root !== 'string' ||
    !root.trim() ||
    root.length > MAX_ROOT_LENGTH ||
    !isAbsolute(root)
  )
    throw new Error('Choose a valid folder to scan')
  const normalized = resolve(root)
  if (
    normalized === parse(normalized).root ||
    normalized === parse(normalized).root.replace(/\\$/, '')
  )
    throw new Error('Choose a folder below the drive root')
  if (!isAbsolute(normalized)) throw new Error('Choose an absolute folder path')
  try {
    const result = lstatSync(normalized)
    if (result.isSymbolicLink()) throw new Error('Choose a regular folder, not a symbolic link')
    if (!result.isDirectory()) throw new Error('Choose a folder to scan')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Choose')) throw error
    throw new Error('The selected folder is unavailable', { cause: error })
  }
  return normalized
}

function shouldSkipDirectory(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRECTORIES.has(name.toLowerCase())
}

function readManifest(path: string): Manifest {
  try {
    if (!existsSync(path)) return { version: 1, jobs: [] }
    const raw = readFileSync(path)
    if (raw.byteLength > MAX_MANIFEST_BYTES) return { version: 1, jobs: [] }
    const value: unknown = JSON.parse(raw.toString('utf8'))
    if (!value || typeof value !== 'object' || (value as Manifest).version !== 1)
      return { version: 1, jobs: [] }
    const jobs = (value as Manifest).jobs
    if (!Array.isArray(jobs)) return { version: 1, jobs: [] }
    return {
      version: 1,
      jobs: jobs.filter(isScanJob).map((job) => ({ ...job, root: resolve(job.root) })),
    }
  } catch {
    return { version: 1, jobs: [] }
  }
}

function isScanJob(value: unknown): value is ScanJob {
  if (!value || typeof value !== 'object') return false
  const job = value as Partial<ScanJob>
  return (
    typeof job.root === 'string' &&
    (job.state === 'running' || job.state === 'complete' || job.state === 'stopped') &&
    Number.isSafeInteger(job.discovered) &&
    Number.isSafeInteger(job.enrolled) &&
    Number.isSafeInteger(job.skipped) &&
    Number.isSafeInteger(job.errors)
  )
}

function saveManifest(path: string, manifest: Manifest): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 })
  renameSync(temporary, path)
}
