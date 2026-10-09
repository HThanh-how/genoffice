import { defineConfig } from 'vitest/config'
import { bundledModulePathPlugin } from './tests/helpers/bundled-module-path-plugin'

export default defineConfig({
  plugins: [bundledModulePathPlugin()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
})

