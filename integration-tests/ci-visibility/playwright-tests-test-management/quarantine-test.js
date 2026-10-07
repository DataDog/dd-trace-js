'use strict'

const { test, expect } = require('@playwright/test')

test.beforeAll(() => {
  if (process.env.FAIL_QUARANTINE_BEFORE_ALL) throw new Error('quarantined suite beforeAll failure')
})

test.afterAll(() => {
  if (process.env.FAIL_QUARANTINE_AFTER_ALL) throw new Error('quarantined suite afterAll failure')
})

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('quarantine', () => {
  test('should quarantine failed test', async ({ page }, testInfo) => {
    if (process.env.EXPECTED_FAILURE_PASSES) {
      test.fail()
      expect(true).toBe(true)
      return
    }

    const shouldPassEfdRetry = process.env.SHOULD_PASS_EFD_RETRIES && testInfo.repeatEachIndex > 0
    const shouldPassNativeRetry = process.env.SHOULD_PASS_NATIVE_RETRIES && testInfo.retry > 0

    await expect(page.locator('.hello-world')).toHaveText([
      shouldPassEfdRetry || shouldPassNativeRetry ? 'Hello World' : 'Hello Warld',
    ])
  })
})
