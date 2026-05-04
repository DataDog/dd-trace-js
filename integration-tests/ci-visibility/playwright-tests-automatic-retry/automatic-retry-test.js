'use strict'

const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('playwright', () => {
  test('should eventually pass after retrying', async ({ page }) => {
    const shouldFail = test.info().retry < 2

    await expect(page.locator('.hello-world')).toHaveText([
      shouldFail ? 'Hello Warld' : 'Hello World',
    ])
  })
})

test.describe.serial('playwright serial', () => {
  test('should fail on first attempt', async ({ page }) => {
    if (test.info().retry === 0) {
      throw new Error('Intentional failure on first attempt')
    }
    await expect(page.locator('.hello-world')).toHaveText(['Hello World'])
  })

  test('should be skipped when previous test fails', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText(['Hello World'])
  })
})
