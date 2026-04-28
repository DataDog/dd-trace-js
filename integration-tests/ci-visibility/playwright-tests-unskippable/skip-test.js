'use strict'

const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test('can be skipped by TIA', async ({ page }) => {
  await expect(page.locator('.hello-world')).toHaveText([
    'Hello World',
  ])
})
