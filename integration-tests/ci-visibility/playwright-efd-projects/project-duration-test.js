'use strict'

const { test, expect } = require('@playwright/test')

test.describe('efd project duration', () => {
  test('project scoped test', async ({ browserName }, testInfo) => {
    if (browserName && testInfo.project.name === 'second-chromium') {
      await new Promise(resolve => setTimeout(resolve, 6_000))
    }
    expect(1 + 1).toBe(2)
  })
})
