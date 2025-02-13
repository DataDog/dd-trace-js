const { test, expect } = require('@playwright/test')

test.describe('quarantine', () => {
  test('should quarantine failed test', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello Warld'
    ])
  })
})
