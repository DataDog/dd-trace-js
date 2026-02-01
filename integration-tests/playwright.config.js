'use strict'

// Playwright config file for integration tests
const { devices } = require('@playwright/test')

const projects = [
  {
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
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

const config = {
  baseURL: process.env.PW_BASE_URL,
  testDir: process.env.TEST_DIR || './ci-visibility/playwright-tests',
  timeout: Number(process.env.TEST_TIMEOUT) || 30000,
  fullyParallel: process.env.FULLY_PARALLEL === 'true',
  workers: process.env.PLAYWRIGHT_WORKERS ? Number(process.env.PLAYWRIGHT_WORKERS) : undefined,
  reporter: 'line',
  /* Configure projects for major browsers */
  projects,
  testMatch: '**/*-test.js',
}

if (process.env.MAX_FAILURES) {
  config.maxFailures = Number(process.env.MAX_FAILURES)
}

module.exports = config
