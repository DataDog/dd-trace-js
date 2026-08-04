import { defineConfig } from 'vite'

const config = {
  test: {
    include: [
      process.env.SECOND_PROJECT_TEST_DIR || 'ci-visibility/vitest-tests/test-visibility*',
    ],
    name: process.env.SECOND_PROJECT_NAME_COLOR
      ? { label: 'second-project-pool', color: process.env.SECOND_PROJECT_NAME_COLOR }
      : 'second-project-pool',
    pool: process.env.SECOND_PROJECT_POOL_CONFIG || 'forks',
  },
}

if (process.env.SECOND_PROJECT_RETRY_CONFIG) {
  config.test.retry = Number(process.env.SECOND_PROJECT_RETRY_CONFIG)
}

export default defineConfig(config)
