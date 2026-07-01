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

if (process.env.PROJECT_POOL_CONFIG) {
  const projectConfigs = []
  const firstProjectConfig = {
    include: [
      process.env.TEST_DIR || 'ci-visibility/vitest-tests/test-visibility*',
    ],
    name: process.env.PROJECT_NAME_COLOR
      ? { label: 'project-pool', color: process.env.PROJECT_NAME_COLOR }
      : 'project-pool',
    pool: process.env.PROJECT_POOL_CONFIG,
  }
  if (process.env.PROJECT_RETRY_CONFIG) {
    firstProjectConfig.retry = Number(process.env.PROJECT_RETRY_CONFIG)
  }
  projectConfigs.push({ test: firstProjectConfig })

  if (process.env.SECOND_PROJECT_CONFIG_FILE) {
    projectConfigs.push('vitest.second-project.config.mjs')
  } else if (process.env.SECOND_PROJECT_POOL_CONFIG) {
    const secondProjectConfig = {
      include: [
        process.env.SECOND_PROJECT_TEST_DIR || 'ci-visibility/vitest-tests/test-visibility*',
      ],
      name: process.env.SECOND_PROJECT_NAME_COLOR
        ? { label: 'second-project-pool', color: process.env.SECOND_PROJECT_NAME_COLOR }
        : 'second-project-pool',
      pool: process.env.SECOND_PROJECT_POOL_CONFIG,
    }
    if (process.env.SECOND_PROJECT_RETRY_CONFIG) {
      secondProjectConfig.retry = Number(process.env.SECOND_PROJECT_RETRY_CONFIG)
    }
    if (process.env.SECOND_PROJECT_UNNAMED) {
      delete secondProjectConfig.name
    }
    projectConfigs.push({ test: secondProjectConfig })
  }

  config.test.projects = projectConfigs
}

if (process.env.COVERAGE_PROVIDER) {
  config.test.coverage = {
    provider: process.env.COVERAGE_PROVIDER || 'v8',
    include: ['ci-visibility/vitest-tests/**'],
    reporter: ['text-summary', 'lcov'],
  }
}

export default defineConfig(config)
