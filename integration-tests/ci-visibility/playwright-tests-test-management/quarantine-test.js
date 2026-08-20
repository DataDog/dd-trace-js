'use strict'

const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('quarantine', () => {
  test('should quarantine failed test', async ({ page }) => {
    const { repeatEachIndex, retry } = test.info()
    const shouldPassEfdRetry = process.env.SHOULD_PASS_EFD_RETRIES && repeatEachIndex > 0
    const shouldPassNativeRetry = process.env.SHOULD_PASS_NATIVE_RETRIES && retry > 0

    await expect(page.locator('.hello-world')).toHaveText([
      shouldPassEfdRetry || shouldPassNativeRetry ? 'Hello World' : 'Hello Warld',
    ])
  })
})
