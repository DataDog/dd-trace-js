'use strict'

const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

const waitFor = (ms) => new Promise(resolve => setTimeout(resolve, ms))

test.describe('playwright', () => {
  test.beforeAll(async () => {
    // timeout error
    await waitFor(3100)
  })
  test('should work with passing tests', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})
