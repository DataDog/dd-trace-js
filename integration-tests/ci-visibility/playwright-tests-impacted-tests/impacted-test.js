'use strict'

const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('impacted test', () => {
  test('should be impacted', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})

test.describe('impacted test 2', () => {
  test('should be impacted 2', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})
