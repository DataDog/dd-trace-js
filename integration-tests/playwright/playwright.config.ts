// Playwright typescript config file for integration tests
// @ts-ignore
import { devices } from '@playwright/test'

export default {
  baseURL: process.env.PW_BASE_URL,
  testDir: './ci-visibility',
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
