'use strict'

// Playwright config file for integration tests
const { devices } = require('@playwright/test')

const config = {
  baseURL: process.env.PW_BASE_URL,
  testDir: './playwright-tests',
  timeout: 30000,
  reporter: 'line',
  projects: [
    {
      name: 'chromium',
      use: devices['Desktop Chrome']
    }
  ],
  testMatch: '**/*-test.js'
}

module.exports = config
