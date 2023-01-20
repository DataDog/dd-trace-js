const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('playwright', () => {
  test('should work with passing tests', async ({ page }) => {
    // Create 1st todo.
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})
