import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

/** The commit this build comes from: CI passes it, a local build asks git; unknown is an empty string. */
function buildCommit(): string {
  const fromCi = process.env.GITHUB_SHA
  if (fromCi) return fromCi.slice(0, 12)
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

export default defineConfig({
  // Bundle everything into the shell main (same policy as apps/docs): the
  // imported docs/sheets main modules are TS source with no build artifacts,
  // so externalizing them would break Node ESM resolution at runtime.
  main: {
    // the diagnostic log names the commit it was produced by
    define: { 'process.env.GENOFFICE_BUILD_COMMIT': JSON.stringify(buildCommit()) },
    // node:sqlite is a Node 22+ builtin the bundler's builtin list may predate
    build: {
      rollupOptions: {
        external: ['node:sqlite', 'onnxruntime-node', '@huggingface/tokenizers', 'tesseract.js'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // dedicated preload for the auto-update window
          update: resolve(__dirname, 'src/preload/update.ts'),
          feedback: resolve(__dirname, 'src/preload/feedback.ts'),
          // dedicated preload for the PDF password prompt window
          'pdf-password': resolve(__dirname, 'src/preload/pdf-password.ts'),
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // strong-guidance update window (see src/main/update-window.ts)
          update: resolve(__dirname, 'src/renderer/update.html'),
          feedback: resolve(__dirname, 'src/renderer/feedback.html'),
          // PDF password prompt window (see src/main/pdf-password-dialog.ts)
          'pdf-password': resolve(__dirname, 'src/renderer/pdf-password.html'),
        },
      },
    },
    server: {
      port: Number(process.env.SHELL_DEV_PORT) || 5199,
      strictPort: Boolean(process.env.SHELL_DEV_PORT),
    },
  },
})
