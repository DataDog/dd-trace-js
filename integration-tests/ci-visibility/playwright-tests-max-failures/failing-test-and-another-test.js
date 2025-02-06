'use strict'

const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test('should work with failing tests', async ({ page }) => {
  await expect(page.locator('.hello-world')).toHaveText([
    'Hello Warld'
  ])
})

test('does not crash afterwards', async ({ page }) => {
  await expect(page.locator('.hello-world')).toHaveText([
    'Hello World'
  ])
})
