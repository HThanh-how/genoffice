import { defineConfig } from 'vitest/config'
import { bundledModulePathPlugin } from './tests/helpers/bundled-module-path-plugin'

export default defineConfig({
  plugins: [bundledModulePathPlugin()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: process.env.CI ? 60000 : 30000,
    setupFiles: ['tests/helpers/model-download-env.ts'],
  },
})
