'use strict'

const { test, expect } = require('@playwright/test')

// Playwright's trace mode defaults to "off". Retaining the trace is what makes Playwright 1.64 record
// the step stack of the afterEach hook injected by Test Optimization, which crashed when the hook had
// no location.
test.use({ trace: 'on' })

test.describe('injected hook location', () => {
  test('first test', async ({ page }) => {
    expect(1).toBe(1)
  })

  test('second test sharing the same parent suite', async ({ page }) => {
    expect(2).toBe(2)
  })
})
