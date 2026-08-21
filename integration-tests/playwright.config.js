'use strict'

// Playwright config file for integration tests
const { devices } = require('@playwright/test')

const projects = [
  {
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      screenshot: process.env.PLAYWRIGHT_FAILURE_SCREENSHOT_MODE || 'off',
    },
  },
]

if (process.env.ADD_EXTRA_PLAYWRIGHT_PROJECT) {
  projects.push({
    name: 'extra-project',
    use: {
      ...devices['Desktop Chrome'],
    },
    dependencies: ['chromium'],
    testMatch: 'did-not-run.js',
  })
}

if (process.env.ADD_DUPLICATE_PLAYWRIGHT_PROJECT) {
  projects.push({
    name: 'second-chromium',
    use: {
      ...devices['Desktop Chrome'],
    },
  })
}

const config = {
  baseURL: process.env.PW_BASE_URL,
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR,
  testDir: process.env.TEST_DIR || './ci-visibility/playwright-tests',
  timeout: Number(process.env.TEST_TIMEOUT) || 30000,
  fullyParallel: process.env.FULLY_PARALLEL === 'true',
  workers: process.env.PLAYWRIGHT_WORKERS ? Number(process.env.PLAYWRIGHT_WORKERS) : undefined,
  reporter: process.env.PLAYWRIGHT_FROZEN_REPORTER
    ? './ci-visibility/playwright-reporter-frozen.js'
    : process.env.PLAYWRIGHT_THROWING_REPORTER
      ? './ci-visibility/playwright-reporter-throws.js'
      : process.env.PLAYWRIGHT_LOGGING_REPORTER
        ? './ci-visibility/playwright-reporter-logs-error.js'
        : 'line',
  /* Configure projects for major browsers */
  projects,
  testMatch: '**/*-test.js',
}

if (process.env.MAX_FAILURES) {
  config.maxFailures = Number(process.env.MAX_FAILURES)
}

if (process.env.FAIL_ON_FLAKY_TESTS) {
  config.failOnFlakyTests = true
}

if (process.env.FAIL_GLOBAL_TEARDOWN) {
  config.globalTeardown = './ci-visibility/playwright-tests-test-management/global-teardown.js'
}

module.exports = config
