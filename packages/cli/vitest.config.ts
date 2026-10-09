import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    // never run the real `agy models` probe (agy-first defaults) from a test
    env: { GENOFFICE_AGY_DETECT: '0' },
  },
})
