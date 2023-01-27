// Playwright config file for integration tests
const { devices } = require('@playwright/test')

module.exports = {
  baseURL: process.env.PW_BASE_URL,
  testDir: './ci-visibility/playwright-tests',
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
