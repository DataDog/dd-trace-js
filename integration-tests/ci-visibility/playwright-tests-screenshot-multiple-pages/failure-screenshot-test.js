'use strict'

const { test, expect } = require('@playwright/test')

test('uploads one automatic failure screenshot for multiple pages', async ({ page, browser }) => {
  await page.goto(process.env.PW_BASE_URL)
  await browser.newPage()

  expect(true).toBe(false)
})
