import { defineConfig } from 'vite'

const config = {
  test: {
    include: [
      process.env.TEST_DIR || 'ci-visibility/vitest-tests/test-visibility*'
    ]
  }
}

if (process.env.COVERAGE_PROVIDER) {
  config.test.coverage = {
    provider: process.env.COVERAGE_PROVIDER || 'v8',
    include: ['ci-visibility/vitest-tests/**'],
    reporter: ['text-summary']
  }
}

export default defineConfig(config)
