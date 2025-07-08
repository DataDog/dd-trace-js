'use strict'

const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('attempt to fix', () => {
  test('should attempt to fix failed test', async ({ page }) => {
    let textToAssert

    if (process.env.SHOULD_ALWAYS_PASS) {
      textToAssert = 'Hello World'
    } else if (process.env.SHOULD_FAIL_SOMETIMES) {
      // can't use numAttempt++ because we're running in parallel
      if (Number(process.env.TEST_WORKER_INDEX) % 2 === 0) {
        throw new Error('Hello Warld')
      }
      textToAssert = 'Hello World'
    } else {
      textToAssert = 'Hello Warld'
    }

    await expect(page.locator('.hello-world')).toHaveText([
      textToAssert
    ])
  })
})
