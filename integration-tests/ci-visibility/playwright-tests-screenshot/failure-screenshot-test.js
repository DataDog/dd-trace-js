'use strict'

const { test, expect } = require('@playwright/test')

if (process.env.PLAYWRIGHT_DELAY_FAILURE_SCREENSHOT_ATTACH === 'true' && process.send) {
  const originalSend = process.send
  let delayedAttachMessage

  process.send = function (message) {
    const dispatchMethod = message?.method === '__dispatch__' && message.params?.method
    if (dispatchMethod === 'attach' && message.params.params?._ddIsAutomaticFailureScreenshot) {
      delayedAttachMessage = message
      return true
    }

    const result = originalSend.apply(process, arguments)
    if (dispatchMethod === 'testEnd' && delayedAttachMessage) {
      process.send = originalSend
      originalSend.call(process, delayedAttachMessage)
      delayedAttachMessage = undefined
    }
    return result
  }
}

test('does not upload programmatic screenshots', async ({ page }, testInfo) => {
  await page.goto(process.env.PW_BASE_URL)

  await page.screenshot({ path: testInfo.outputPath('programmatic-screenshot.png') })
})

test.skip('does not reserve a worker trace slot for an expected skip', () => {})

test('uploads only the automatic failure screenshot', async ({ page }, testInfo) => {
  await page.goto(process.env.PW_BASE_URL)

  const manualScreenshotPath = testInfo.outputPath('test-failed-99.png')
  await page.screenshot({ path: manualScreenshotPath })
  await testInfo.attach('screenshot', {
    path: manualScreenshotPath,
    contentType: 'image/png',
  })

  const injectedScreenshotPath = testInfo.outputPath('test-failed-98.png')
  await page.screenshot({ path: injectedScreenshotPath })
  testInfo.attachments.push({
    name: 'screenshot',
    path: injectedScreenshotPath,
    contentType: 'image/png',
  })

  expect(true).toBe(false)
})
