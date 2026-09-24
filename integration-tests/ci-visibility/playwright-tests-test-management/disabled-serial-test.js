'use strict'

const { test, expect } = require('@playwright/test')

test.describe.serial('disabled serial retry', () => {
  test('fails on the first attempt', async () => {
    expect(test.info().retry).toBe(1)
  })

  test('should not run disabled sibling', () => {
    throw new Error('SHOULD NOT BE EXECUTED')
  })

  if (process.env.FAIL_AFTER_DISABLED === 'true') {
    test('uploads screenshot after disabled sibling', async ({ page }) => {
      await page.goto(process.env.PW_BASE_URL)

      expect(true).toBe(false)
    })
  }
})
