'use strict'

const { test, expect } = require('@playwright/test')

test('uploads only the automatic failure screenshot', async ({ page }, testInfo) => {
  await page.goto('/')

  const manualScreenshotPath = testInfo.outputPath('manual-screenshot.png')
  await page.screenshot({ path: manualScreenshotPath })
  await testInfo.attach('screenshot', {
    path: manualScreenshotPath,
    contentType: 'image/png',
  })

  expect(true).toBe(false)
})
