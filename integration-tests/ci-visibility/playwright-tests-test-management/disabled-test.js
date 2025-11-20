'use strict'

/* eslint-disable no-console */

const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('disable', () => {
  test('should disable test', async ({ page }) => {
    console.log('SHOULD NOT BE EXECUTED')
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello Warld'
    ])
  })
})

test.describe('not disabled', () => {
  test('should not disable test', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})

test.describe('not disabled 2', () => {
  test('should not disable test 2', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})

test.describe('not disabled 3', () => {
  test('should not disable test 3', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})
