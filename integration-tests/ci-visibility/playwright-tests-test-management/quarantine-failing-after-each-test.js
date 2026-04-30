'use strict'

const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('quarantine with failing afterEach', () => {
  test.afterEach(async () => {
    throw new Error('afterEach hook error')
  })

  test('should quarantine a test whose afterEach hook fails', async ({ page }) => {
    // test body passes but afterEach will throw, causing test status='fail'
    await expect(page.locator('.hello-world')).toHaveText(['Hello World'])
  })
})

test.describe('not quarantined', () => {
  test('should pass normally', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText(['Hello World'])
  })
})
