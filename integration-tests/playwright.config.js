// Playwright config file for integration tests
const { devices } = require('@playwright/test')

module.exports = {
  baseURL: process.env.PW_BASE_URL,
  testDir: process.env.TEST_DIR || './ci-visibility/playwright-tests',
  timeout: Number(process.env.TEST_TIMEOUT) || 30000,
  reporter: 'line',
  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome']
      }
    }
  ],
  testMatch: '**/*-test.js'
}
