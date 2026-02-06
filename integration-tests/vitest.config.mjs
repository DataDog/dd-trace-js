import { defineConfig } from 'vite'

const config = {
  test: {
    include: [
      process.env.TEST_DIR || 'ci-visibility/vitest-tests/test-visibility*',
    ],
    pool: process.env.POOL_CONFIG || 'forks',
  },
}

if (process.env.COVERAGE_PROVIDER) {
  config.test.coverage = {
    provider: process.env.COVERAGE_PROVIDER || 'v8',
    include: ['ci-visibility/vitest-tests/**'],
    reporter: process.env.VITEST_COVERAGE_MULTIPLE_REPORTERS
      ? ['text-summary', 'lcov', 'cobertura']
      : ['text-summary', 'lcov'],
  }
}

export default defineConfig(config)
