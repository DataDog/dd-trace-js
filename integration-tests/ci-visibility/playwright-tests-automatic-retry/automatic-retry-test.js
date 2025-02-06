'use strict'

const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('playwright', () => {
  test('should eventually pass after retrying', async ({ page }) => {
    const shouldFail = test.info().retry < 2

    await expect(page.locator('.hello-world')).toHaveText([
      shouldFail ? 'Hello Warld' : 'Hello World'
    ])
  })
})
