'use strict'

const { test, expect } = require('@playwright/test')

test('does not upload programmatic screenshots', async ({ page }, testInfo) => {
  await page.goto(process.env.PW_BASE_URL)

  await page.screenshot({ path: testInfo.outputPath('programmatic-screenshot.png') })
})

test('uploads only the automatic failure screenshot', async ({ page }, testInfo) => {
  await page.goto(process.env.PW_BASE_URL)

  const manualScreenshotPath = testInfo.outputPath('test-failed-99.png')
  await page.screenshot({ path: manualScreenshotPath })
  await testInfo.attach('screenshot', {
    path: manualScreenshotPath,
    contentType: 'image/png',
  })

  expect(true).toBe(false)
})
