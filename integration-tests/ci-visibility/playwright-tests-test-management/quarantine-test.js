'use strict'

const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('quarantine', () => {
  test('should quarantine failed test', async ({ page }) => {
    const shouldFail = !process.env.SHOULD_PASS_EFD_RETRIES || test.info().repeatEachIndex === 0

    await expect(page.locator('.hello-world')).toHaveText([
      shouldFail ? 'Hello Warld' : 'Hello World',
    ])
  })
})
