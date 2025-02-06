'use strict'

const { test, expect } = require('@playwright/test')
const tracer = require('dd-trace')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('playwright', () => {
  test('should be able to grab the active test span and add a custom span', async ({ page }) => {
    const customSpan = tracer.startSpan('my custom span', {
      childOf: tracer.scope().active()
    })

    customSpan.addTags({
      'test.really_custom_tag': 'this is really custom'
    })

    customSpan.finish()

    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})
