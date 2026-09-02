import { defineConfig } from 'vite'
import { BaseSequencer } from 'vitest/node'

let defineVitestConfig = defineConfig

class CustomSequencer extends BaseSequencer {
  async shard (files) {
    return files
  }

  async sort (files) {
    if (process.env.CUSTOM_SEQUENCER_MARKER) {
      // eslint-disable-next-line no-console
      console.log(process.env.CUSTOM_SEQUENCER_MARKER)
    }
    return super.sort(files)
  }
}

const config = {
  test: {
    include: [
      process.env.TEST_DIR || 'ci-visibility/vitest-tests/test-visibility*',
    ],
    reporters: ['default'],
  },
}

if (process.env.VITEST_THROWING_REPORTER) {
  config.test.reporters.push('./ci-visibility/vitest-reporter-throws.mjs')
}

if (process.env.VITEST_PRESERVE_SYMLINKS) {
  config.resolve = {
    preserveSymlinks: true,
  }
}

const poolConfig = process.env.POOL_CONFIG || 'forks'
if (!process.env.USE_VITEST_DEFAULT_POOL) {
  config.test.pool = poolConfig
}

if (process.env.NO_ISOLATE) {
  config.test.isolate = false
}

if (process.env.POOL_NO_ISOLATE) {
  config.test.poolOptions = {
    [poolConfig]: {
      isolate: false,
    },
  }
}

if (process.env.VITEST_SETUP_FILE) {
  config.test.setupFiles = process.env.VITEST_SETUP_FILE
}

if (process.env.VITEST_PARTIAL_PROCESS_SHIM) {
  config.define = {
    'globalThis.process': JSON.stringify({
      env: {},
      versions: {
        node: '20.0.0',
      },
    }),
  }
}

if (process.env.CUSTOM_SEQUENCER) {
  config.test.sequence = {
    sequencer: CustomSequencer,
  }
}

if (process.env.VITEST_HOOKS_SEQUENCE) {
  config.test.sequence = {
    ...config.test.sequence,
    hooks: process.env.VITEST_HOOKS_SEQUENCE,
  }
}

if (process.env.VITEST_RUNNER) {
  config.test.runner = process.env.VITEST_RUNNER
}

const browserProvider = process.env.VITEST_BROWSER_PROVIDER || 'playwright'
const browserName = browserProvider === 'webdriverio' ? 'chrome' : 'chromium'

async function getBrowserProvider () {
  if (!process.env.VITEST_BROWSER_PROVIDER_FACTORY) return browserProvider

  if (browserProvider === 'webdriverio') {
    const { webdriverio } = await import('@vitest/browser-webdriverio')
    const capabilities = {
      'goog:chromeOptions': {
        args: ['disable-dev-shm-usage', 'no-sandbox'],
      },
    }
    if (process.env.VITEST_BROWSER_BINARY) {
      capabilities['goog:chromeOptions'].binary = process.env.VITEST_BROWSER_BINARY
    }
    if (process.env.VITEST_BROWSER_DRIVER_BINARY) {
      capabilities['wdio:chromedriverOptions'] = {
        binary: process.env.VITEST_BROWSER_DRIVER_BINARY,
      }
    }
    return webdriverio({
      capabilities,
    })
  }

  return (await import('@vitest/browser-playwright')).playwright()
}

if (process.env.VITEST_BROWSER_MODE) {
  config.test.browser = {
    connectTimeout: process.env.VITEST_BROWSER_CONNECT_TIMEOUT
      ? Number(process.env.VITEST_BROWSER_CONNECT_TIMEOUT)
      : undefined,
    enabled: true,
    headless: true,
    provider: await getBrowserProvider(),
    instances: [{
      browser: browserName,
      name: `browser-${browserName}`,
    }],
  }
}

if (process.env.VITEST_MIXED_BROWSER_MODE) {
  config.test.projects = [
    {
      test: {
        include: ['ci-visibility/vitest-browser-tests/mixed-node.mjs'],
        name: 'node-project',
        pool: 'forks',
      },
    },
    {
      test: {
        browser: {
          enabled: true,
          headless: true,
          provider: await getBrowserProvider(),
          instances: [{
            browser: browserName,
            name: `browser-${browserName}`,
          }],
        },
        include: ['ci-visibility/vitest-browser-tests/browser-reporting.mjs'],
        name: 'browser-project',
      },
    },
  ]
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
  if (process.env.PROJECT_NO_ISOLATE) {
    firstProjectConfig.isolate = false
  }
  if (process.env.PROJECT_POOL_NO_ISOLATE) {
    firstProjectConfig.poolOptions = {
      [firstProjectConfig.pool]: {
        isolate: false,
      },
    }
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
    include: [process.env.COVERAGE_INCLUDE || 'ci-visibility/vitest-tests/**'],
    reporter: ['text-summary', 'lcov'],
  }
}

if (process.env.CLOUDFLARE_WORKERS_POOL) {
  const { defineWorkersConfig } = await import('@cloudflare/vitest-pool-workers/config')

  defineVitestConfig = defineWorkersConfig
  config.test.poolOptions = {
    ...config.test.poolOptions,
    workers: {
      ...config.test.poolOptions?.workers,
      miniflare: {
        compatibilityDate: '2025-01-01',
      },
    },
  }
}

export default defineVitestConfig(config)
