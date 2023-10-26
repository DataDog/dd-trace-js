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
  test('should work with annotated tests', async ({ page }) => {
    test.info().annotations.push({ type: 'DD_TAGS[test.memory.usage]', description: 'low' })
    test.info().annotations.push({ type: 'DD_TAGS[test.memory.allocations]', description: 16 })
    // this is malformed and should be ignored
    test.info().annotations.push({ type: 'DD_TAGS[test.invalid', description: 'high' })
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})
