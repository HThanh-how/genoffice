import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// resolve sibling source packages by path (not via node_modules), so a git
// worktree whose node_modules is linked to another checkout still tests
// against this checkout's edits (same convention as apps/docs and packages/pdf2docx)
const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@genoffice/ai-provider/browser': local('../../packages/ai-provider/src/browser.ts'),
      '@genoffice/ai-provider': local('../../packages/ai-provider/src/index.ts'),
    },
  },
  server: {
    fs: {
      strict: false,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
