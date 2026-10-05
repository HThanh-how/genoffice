import type { WebContents } from 'electron'

/**
 * A small record of what each tab's page did while it loaded, for the day a tab shows up white and
 * nobody can say why: load failures, a renderer that died or hung, warnings and errors from its
 * console, and two probes of what is actually on the page a few seconds after it opened.
 */
export type DiagnosticsWrite = (line: string) => void

const MAX_MESSAGE = 400

const clip = (value: unknown): string =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_MESSAGE)

/** What to look for on the page: is anything mounted, how big is it, how much text is there (length only, never content). */
export const PROBE_SCRIPT = `(function(){
  var root=document.getElementById('root')||document.getElementById('app')||document.body;
  var canvases=document.querySelectorAll('canvas');
  var area=0; for(var i=0;i<canvases.length;i++){area+=canvases[i].width*canvases[i].height}
  return JSON.stringify({state:document.readyState, w:innerWidth, h:innerHeight, visible:document.visibilityState,
    rootChildren:root?root.children.length:-1, canvases:canvases.length, canvasPixels:area,
    bodyLength:(document.body&&document.body.innerText||'').length});
})()`

export function attachRendererDiagnostics(
  wc: WebContents,
  label: string,
  write: DiagnosticsWrite,
  probeAfterMs: readonly number[] = [6000, 20000],
): void {
  const started = Date.now()
  const log = (event: string, detail = ''): void => {
    write(
      `${new Date().toISOString()} +${Date.now() - started}ms [${label}] ${event}${detail ? ' ' + detail : ''}`,
    )
  }
  const gone = (): boolean => wc.isDestroyed()
  log('created')
  wc.on('did-finish-load', () => log('did-finish-load', clip(wc.getURL()).slice(-80)))
  wc.on('did-fail-load', (_event, code, description, url) =>
    log('did-fail-load', `${code} ${clip(description)} ${clip(url).slice(-80)}`),
  )
  wc.on('render-process-gone', (_event, details) =>
    log('render-process-gone', `${details.reason} exit=${details.exitCode}`),
  )
  wc.on('unresponsive', () => log('unresponsive'))
  wc.on('responsive', () => log('responsive'))
  wc.on('preload-error', (_event, path, error) =>
    log('preload-error', `${clip(path)} ${clip(error)}`),
  )
  wc.on('console-message', (...args: unknown[]) => {
    // Electron passes one details object; older builds passed positional arguments
    const first = args[0] as {
      level?: unknown
      message?: unknown
      lineNumber?: unknown
      sourceId?: unknown
    }
    const details =
      first && typeof first === 'object' && 'message' in first
        ? first
        : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] }
    const level = details.level
    const severe = level === 'warning' || level === 'error' || level === 2 || level === 3
    if (!severe) return
    log(
      'console',
      `${String(level)} ${clip(details.message)} (${clip(details.sourceId).slice(-60)}:${String(details.lineNumber ?? '')})`,
    )
  })
  for (const ms of probeAfterMs) {
    const timer = setTimeout(() => {
      if (gone()) return
      wc.executeJavaScript(PROBE_SCRIPT)
        .then((result: unknown) => log(`probe@${ms / 1000}s`, clip(result)))
        .catch((error: unknown) => log(`probe@${ms / 1000}s failed`, clip(error)))
    }, ms)
    timer.unref?.()
    wc.once('destroyed', () => clearTimeout(timer))
  }
  wc.once('destroyed', () => log('destroyed'))
}

/** Appends lines to one file, starting a fresh one when it grows past `maxBytes`. */
export function rotatingFileWriter(
  path: string,
  deps: {
    append(path: string, text: string): void
    size(path: string): number
    rename(from: string, to: string): void
  },
  maxBytes = 1024 * 1024,
): DiagnosticsWrite {
  return (line) => {
    try {
      if (deps.size(path) > maxBytes) deps.rename(path, `${path}.1`)
      deps.append(path, `${line}\n`)
    } catch {
      // a diagnostic record must never get in the way of opening a document
    }
  }
}
