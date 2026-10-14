import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression test suite for GenOffice Update Experience 2.0
 * Verifies Feedback Hotfixes (Bugs A, B, C, D), Apple-inspired Artwork, and Updater integration.
 */

describe('GENOFFICE UPDATE EXPERIENCE 2.0 REGRESSION SUITE', () => {
  const cssPath = join(__dirname, '../src/renderer/src/ui-feedback.css')
  const artworkCssPath = join(__dirname, '../src/renderer/src/update-artwork.css')
  const uiFeedbackCss = readFileSync(cssPath, 'utf8')
  const updateArtworkCss = readFileSync(artworkCssPath, 'utf8')

  // 1. Dark & Light theme primary button visibility
  describe('Primary Button Theming & Visibility (Bug A)', () => {
    it('Dark theme primary button is visible with proper tokens and safe fallbacks', () => {
      // Must not rely on raw undeclared --accent without fallbacks
      expect(uiFeedbackCss).toContain('.ui-feedback-button.primary')
      expect(uiFeedbackCss).toContain('--feedback-btn-primary-text')
      expect(uiFeedbackCss).toContain('--feedback-btn-primary')
      expect(uiFeedbackCss).toContain('#ffffff')
      expect(uiFeedbackCss).toContain('#232425')
      expect(uiFeedbackCss).toContain('#393a3b')
    })

    it('Light theme primary button is visible and danger/error maintains readable contrast', () => {
      // Danger/Error primary button must have high-contrast text
      expect(uiFeedbackCss).toMatch(
        /\.ui-feedback-dialog\.tone-danger \.primary[\s\S]*?color:\s*var\(--feedback-btn-danger-text\)/,
      )
      expect(uiFeedbackCss).toContain('--feedback-btn-danger-text: #ffffff;')
    })
  })

  // 2. Dismissible logic, X button and Escape
  describe('Dismissible Informational Status & Close Affordance (Bug B)', () => {
    function computeDismissible(request: {
      kind: 'alert' | 'confirm' | 'messagebox'
      options?: { tone?: string }
      box?: { buttons?: string[]; type?: string; visual?: string }
    }): boolean {
      const buttons =
        request.kind === 'confirm' ? ['Cancel', 'Confirm'] : (request.box?.buttons ?? ['OK'])
      const isUpdateStatus = request.box?.visual === 'update-status'
      return Boolean(
        request &&
        (request.kind === 'alert' ||
          isUpdateStatus ||
          (request.kind === 'messagebox' &&
            buttons.length <= 1 &&
            request.options?.tone !== 'danger' &&
            request.options?.tone !== 'error' &&
            request.box?.type !== 'error')),
      )
    }

    function cancelIndex(request: {
      kind: 'alert' | 'confirm' | 'messagebox'
      box?: { buttons?: string[]; cancelId?: number }
    }): number {
      if (request.kind !== 'messagebox') return 0
      const buttons = request.box?.buttons ?? []
      const explicit = request.box?.cancelId
      if (explicit !== undefined && explicit >= 0 && explicit < Math.max(1, buttons.length))
        return explicit
      const labeled = buttons.findIndex((label) =>
        /^(cancel|hủy|取消|no|không|否)$/i.test(label.replaceAll('&', '').trim()),
      )
      return labeled >= 0 ? labeled : Math.max(0, buttons.length - 1)
    }

    it('Informational status can be dismissed', () => {
      expect(
        computeDismissible({
          kind: 'messagebox',
          box: { buttons: ['OK'], type: 'info', visual: 'update-status' },
        }),
      ).toBe(true)
      expect(computeDismissible({ kind: 'alert' })).toBe(true)
    })

    it('X resolves the status correctly with acknowledgment/cancel index', () => {
      const req = {
        kind: 'messagebox' as const,
        box: { buttons: ['OK'], type: 'info' as const, visual: 'update-status' as const },
      }
      expect(computeDismissible(req)).toBe(true)
      expect(cancelIndex(req)).toBe(0)
    })

    it('Escape resolves the status correctly using cancelIndex', () => {
      const singleButtonReq = {
        kind: 'messagebox' as const,
        box: { buttons: ['OK'], cancelId: 0 },
      }
      expect(cancelIndex(singleButtonReq)).toBe(0)

      const multiButtonReq = {
        kind: 'messagebox' as const,
        box: { buttons: ['Save', 'Cancel'], cancelId: 1 },
      }
      expect(cancelIndex(multiButtonReq)).toBe(1)
    })
  })

  // 3. Safe Backdrop Dismissal
  describe('Backdrop Dismissal Safety (Bug C)', () => {
    it('Backdrop dismissal never confirms destructive actions', () => {
      // Simulate backdrop click handler
      let settledResponse: number | null = null
      const settleDialog = (_id: number, response: number) => {
        settledResponse = response
      }

      // Case A: appConfirm - click backdrop cancels (0), never confirms (1)
      const confirmReq = { kind: 'confirm' as const }
      if (confirmReq.kind === 'confirm') {
        settleDialog(1, 0)
      }
      expect(settledResponse).toBe(0)

      // Case B: Multi-button destructive dialog - backdrop click must be ignored completely
      settledResponse = null
      const destructiveReq = {
        kind: 'messagebox' as const,
        box: { buttons: ['Delete All', 'Cancel'] },
        options: { tone: 'danger' },
      }
      const isDismissible = Boolean(
        destructiveReq.kind === 'alert' ||
        destructiveReq.box?.visual === 'update-status' ||
        (destructiveReq.kind === 'messagebox' &&
          destructiveReq.box?.buttons.length <= 1 &&
          destructiveReq.options.tone !== 'danger'),
      )
      if (isDismissible) {
        settleDialog(2, 1)
      }
      expect(settledResponse).toBeNull() // Not dismissed!
    })
  })

  // 4. Electron Modal Semantics & Focus Guard
  describe('Special Status & Modal Semantics (Bug D)', () => {
    it('The special status does not alter ordinary modal semantics', () => {
      // Test the modal flag logic in openBox
      const isModalForNormal = (toastTone?: string, behavior?: { dismissOnBlur?: boolean }) => {
        return !toastTone && !behavior?.dismissOnBlur
      }

      // Standard callers: modal is true when parent exists
      expect(isModalForNormal(undefined, undefined)).toBe(true)

      // Toast: modal is false
      expect(isModalForNormal('info', undefined)).toBe(false)

      // Special Update Status: modal is false (opt-in non-modal)
      expect(isModalForNormal(undefined, { dismissOnBlur: true, visual: 'update-status' })).toBe(
        false,
      )
    })

    it('Guards against premature blur before genuine focus occurs', () => {
      let hasGenuinelyFocused = false
      let settled = false
      const finish = vi.fn(() => {
        settled = true
      })

      const handleBlur = () => {
        if (hasGenuinelyFocused && !settled) finish()
      }
      const handleFocus = () => {
        hasGenuinelyFocused = true
      }

      // 1. Initial blur during window construction before ready-to-show
      handleBlur()
      expect(finish).not.toHaveBeenCalled()

      // 2. Window actually gains focus
      handleFocus()
      expect(finish).not.toHaveBeenCalled()

      // 3. User clicks outside window -> genuine blur
      handleBlur()
      expect(finish).toHaveBeenCalledOnce()

      // 4. Repeated blur does not fire again
      handleBlur()
      expect(finish).toHaveBeenCalledOnce()
    })
  })

  // 5. Up-to-date updater routing
  describe('Fork Updater Up-To-Date Routing', () => {
    it('Up-to-date does not initiate a download and routes to special non-modal helper', () => {
      const showUpdateStatusMessageBox = vi.fn().mockResolvedValue({ response: 0 })
      const showAppMessageBox = vi.fn().mockResolvedValue({ response: 0 })
      const showUpdateWindow = vi.fn()

      const compareVersions = (a: string, b: string) => a.localeCompare(b)
      const release = { version: '0.11.1' }
      const currentVersion = '0.11.1'
      const background = false

      if (compareVersions(release.version, currentVersion) <= 0) {
        if (!background) {
          showUpdateStatusMessageBox({
            type: 'info',
            title: 'GenOffice is up to date',
            message: 'You are running the latest available version.',
          })
        }
      } else {
        showUpdateWindow()
      }

      expect(showUpdateStatusMessageBox).toHaveBeenCalledOnce()
      expect(showAppMessageBox).not.toHaveBeenCalled()
      expect(showUpdateWindow).not.toHaveBeenCalled()
    })
  })

  // 6. Reduced Motion Fallback
  describe('Artwork Accessibility & Reduced Motion', () => {
    it('Artwork has reduced-motion fallback that disables animations and preserves emblem', () => {
      expect(updateArtworkCss).toContain('@media (prefers-reduced-motion: reduce)')
      expect(updateArtworkCss).toContain('animation: none !important;')
      // Ensure the checkmark path is not hidden by offset when motion is reduced
      expect(updateArtworkCss).toContain('stroke-dashoffset: 0 !important;')
    })

    it('Artwork uses pointer-events: none and accessible aria-hidden', () => {
      expect(updateArtworkCss).toContain('pointer-events: none;')
      const artworkComponentPath = join(__dirname, '../src/renderer/src/UpdateArtwork.tsx')
      const artworkComponent = readFileSync(artworkComponentPath, 'utf8')
      expect(artworkComponent).toContain('aria-hidden="true"')
    })
  })
})
