'use strict'

const { test, expect } = require('@playwright/test')

test.describe('efd failure screenshot alignment', () => {
  test('skips its scheduled retry after running slowly', async () => {
    await new Promise(resolve => setTimeout(resolve, 5_100))
  })

  test('uploads a failure screenshot', async ({ page }) => {
    await page.goto(process.env.PW_BASE_URL)

    expect(true).toBe(false)
  })
})
