'use strict'

const { writeFileSync } = require('node:fs')

const { test: base, expect } = require('@playwright/test')

let releaseDeferredFailureScreenshot
const test = base.extend({
  deferFailureScreenshotAttachment: [async ({ screenshot }, use, testInfo) => {
    if (process.env.PLAYWRIGHT_DEFER_FAILURE_SCREENSHOT_ATTACHMENT !== 'true' || screenshot === 'off') {
      await use()
      return
    }

    const originalAttachmentsPush = testInfo.attachments.push.bind(testInfo.attachments)
    testInfo.attachments.push = (...attachments) => {
      const hasFailureScreenshot = attachments.some(({ name, path }) =>
        name === 'screenshot' && /test-failed-1\.png$/.test(path ?? ''))
      if (hasFailureScreenshot) {
        releaseDeferredFailureScreenshot = () => originalAttachmentsPush(...attachments)
        return testInfo.attachments.length + attachments.length
      }
      return originalAttachmentsPush(...attachments)
    }
    await use()
  }, { auto: true }],
  // The worker fixture must not depend on Playwright's test-scoped screenshot fixture.
  // eslint-disable-next-line no-empty-pattern
  releaseDeferredFailureScreenshot: [async ({}, use) => {
    await use()
    if (releaseDeferredFailureScreenshot) {
      setImmediate(releaseDeferredFailureScreenshot)
    }
  }, { auto: true, scope: 'worker' }],
})

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

  const manualVideoPath = testInfo.outputPath('manual-video.webm')
  writeFileSync(manualVideoPath, 'manual video attachment')
  await testInfo.attach('video', {
    path: manualVideoPath,
    contentType: 'video/webm',
  })

  const injectedVideoPath = testInfo.outputPath('injected-video.webm')
  writeFileSync(injectedVideoPath, 'injected video attachment')
  testInfo.attachments.push({
    name: 'video',
    path: injectedVideoPath,
    contentType: 'video/webm',
  })

  if (process.env.PLAYWRIGHT_AUTO_NAMED_MANUAL_VIDEO === 'true') {
    const autoNamedManualVideoPath = testInfo.outputPath('video-2.webm')
    writeFileSync(autoNamedManualVideoPath, 'manual video attachment with an automatic filename')
    await testInfo.attach('video', {
      path: autoNamedManualVideoPath,
      contentType: 'video/webm',
    })
  }

  expect(true).toBe(false)
})
