'use strict'
const { test, expect } = require('@playwright/test')

test('fails and triggers a screenshot', async ({ page }) => {
  await page.goto('/')
  expect(true).toBe(false)
})

test('passes without a screenshot', async () => {
  // intentionally passes
})
