/* eslint-disable jsdoc/valid-types */
/**
 * @datadog {"unskippable": true}
 */
'use strict'

const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test('is forced to run when TIA wants to skip it', async ({ page }) => {
  await expect(page.locator('.hello-world')).toHaveText([
    'Hello World',
  ])
})
