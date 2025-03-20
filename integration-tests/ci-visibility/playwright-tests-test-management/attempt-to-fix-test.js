const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('attempt to fix', () => {
  test('should attempt to fix failed test', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello Warld'
    ])
  })
})
