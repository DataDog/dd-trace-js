const { test, expect } = require('@playwright/test')

test.describe('playwright', () => {
  test('should have RUM active', async ({ page }) => {
    await page.goto(process.env.PW_BASE_URL)
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})
