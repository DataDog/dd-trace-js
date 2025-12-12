'use strict'

const { test, expect } = require('@playwright/test')

test.describe('flaky', () => {
  test('should be flaky', async ({ page }, testInfo) => {
    if (testInfo.retry === 0) {
      throw new Error('I am flaky')
    }
    expect(true).toBe(true)
  })
})
