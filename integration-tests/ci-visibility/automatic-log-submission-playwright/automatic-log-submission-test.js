'use strict'

const { test, expect } = require('@playwright/test')
const logger = require('./logger')
const sum = require('./sum')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('playwright', () => {
  test('should be able to log to the console', async ({ page }) => {
    test.step('log to the console', async () => {
      logger.log('info', 'Hello simple log!')
    })

    expect(sum(1, 2)).toEqual(3)

    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})
