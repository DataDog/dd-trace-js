'use strict'

const { test, expect } = require('@playwright/test')
// eslint-disable-next-line no-unused-vars
const dummy = require('dummy') // This should not exist, so should throw an error

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('exit code', () => {
  test('should exit with code 1', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})
