import type { SplashApp } from './opening-window'

export interface OverlaySpec {
  fileName: string
  app: SplashApp
}

export interface OverlayHandle {
  /** shown only while its own tab is the one in front */
  setVisible(visible: boolean): void
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
  /** start the fade-out; the view is removed by `destroy` once it has played */
  fadeOut(): void
  destroy(): void
}

export interface OverlayDeps {
  create(spec: OverlaySpec): OverlayHandle
  now(): number
  /** runs `fn` after `ms`; the returned function cancels it */
  schedule(fn: () => void, ms: number): () => void
}

/** Never flash for a document that opens in a blink, never hold a tab for ever. */
export const OVERLAY_MIN_SHOW_MS = 900
export const OVERLAY_FADE_MS = 350
export const OVERLAY_MAX_WAIT_MS = 15_000

interface Entry {
  handle: OverlayHandle
  shownAt: number
  finishing: boolean
  cancel: Array<() => void>
}

/**
 * The "opening" scene laid over a tab's content (the tab strip and the other tabs stay as they
 * are) from the moment the tab is created until its document says it is ready, so the person
 * never watches a half-built editor. One overlay per tab, shown only with its tab.
 */
export class OpeningOverlays {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly deps: OverlayDeps,
    private readonly timing = {
      minShowMs: OVERLAY_MIN_SHOW_MS,
      fadeMs: OVERLAY_FADE_MS,
      maxWaitMs: OVERLAY_MAX_WAIT_MS,
    },
  ) {}

  has(tabId: string): boolean {
    return this.entries.has(tabId)
  }

  begin(tabId: string, spec: OverlaySpec): void {
    this.drop(tabId)
    const entry: Entry = {
      handle: this.deps.create(spec),
      shownAt: this.deps.now(),
      finishing: false,
      cancel: [],
    }
    entry.cancel.push(this.deps.schedule(() => this.finish(tabId), this.timing.maxWaitMs))
    this.entries.set(tabId, entry)
  }

  /** The document is ready: reveal it once the scene has been on screen long enough. */
  ready(tabId: string): void {
    const entry = this.entries.get(tabId)
    if (!entry || entry.finishing) return
    const wait = Math.max(0, entry.shownAt + this.timing.minShowMs - this.deps.now())
    entry.cancel.push(this.deps.schedule(() => this.finish(tabId), wait))
  }

  /** Only the overlay of the tab in front is visible. */
  activate(activeTabId: string | null): void {
    for (const [id, entry] of this.entries) entry.handle.setVisible(id === activeTabId)
  }

  layout(
    activeTabId: string | null,
    bounds: { x: number; y: number; width: number; height: number },
  ): void {
    const entry = activeTabId ? this.entries.get(activeTabId) : undefined
    entry?.handle.setBounds(bounds)
  }

  /** The tab went away (closed, crashed): take its overlay with it, no fade. */
  drop(tabId: string): void {
    const entry = this.entries.get(tabId)
    if (!entry) return
    for (const cancel of entry.cancel) cancel()
    this.entries.delete(tabId)
    entry.handle.destroy()
  }

  private finish(tabId: string): void {
    const entry = this.entries.get(tabId)
    if (!entry || entry.finishing) return
    entry.finishing = true
    for (const cancel of entry.cancel) cancel()
    entry.cancel = []
    entry.handle.fadeOut()
    entry.cancel.push(
      this.deps.schedule(() => {
        this.entries.delete(tabId)
        entry.handle.destroy()
      }, this.timing.fadeMs),
    )
  }
}
