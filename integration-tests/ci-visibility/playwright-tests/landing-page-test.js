const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('playwright', () => {
  test('should work with passing tests', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
  test.skip('should work with skipped tests', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
  test.fixme('should work with fixme', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello Warld'
    ])
  })
})
