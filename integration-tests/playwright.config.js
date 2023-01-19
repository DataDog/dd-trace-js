const { devices } = require('@playwright/test')

module.exports = {
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
