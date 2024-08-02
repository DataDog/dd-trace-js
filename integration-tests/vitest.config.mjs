import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    include: [
      process.env.TEST_DIR || 'ci-visibility/vitest-tests/test-visibility*'
    ],
    coverage: {
      provider: process.env.COVERAGE_PROVIDER || 'v8',
      include: ['ci-visibility/vitest-tests/**'],
      reporter: 'text-summary'
    }
  }
})
