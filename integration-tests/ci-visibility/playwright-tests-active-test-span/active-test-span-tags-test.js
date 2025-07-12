'use strict'

const { test, expect } = require('@playwright/test')
const tracer = require('dd-trace')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('playwright', () => {
  test('should be able to grab the active test span', async ({ page }) => {
    const testSpan = tracer.scope().active()

    testSpan.addTags({
      'test.custom_tag': 'this is custom'
    })

    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})
