import { defineConfig } from 'vite'

class CustomSequencer {
  async shard (files) {
    return files
  }

  async sort (files) {
    if (process.env.CUSTOM_SEQUENCER_MARKER) {
      // eslint-disable-next-line no-console
      console.log(process.env.CUSTOM_SEQUENCER_MARKER)
    }
    return files
  }
}

const config = {
  test: {
    include: [
      process.env.TEST_DIR || 'ci-visibility/vitest-tests/test-visibility*',
    ],
    pool: process.env.POOL_CONFIG || 'forks',
    reporters: ['default'],
  },
}

if (process.env.CUSTOM_SEQUENCER) {
  config.test.sequence = {
    sequencer: CustomSequencer,
  }
}

if (process.env.COVERAGE_PROVIDER) {
  config.test.coverage = {
    provider: process.env.COVERAGE_PROVIDER || 'v8',
    include: ['ci-visibility/vitest-tests/**'],
    reporter: ['text-summary', 'lcov'],
  }
}

export default defineConfig(config)
