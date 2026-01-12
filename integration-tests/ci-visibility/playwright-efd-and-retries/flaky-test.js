'use strict'

const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('playwright', () => {
  test('should not retry new tests', async ({ page }, testInfo) => {
    // test will always fail because ATR and --retries are disabled for EFD
    if (testInfo.retry === 0) {
      throw new Error('Hello Warld')
    }
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })

  test('should retry old flaky tests', async ({ page }, testInfo) => {
    // will eventually pass because the test is not retried by EFD
    if (testInfo.retry === 0) {
      throw new Error('Hello Warld')
    }
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})
