'use strict'

const { test } = require('@playwright/test')

// Playwright 1.62 requires the first hook argument to use object destructuring.
// eslint-disable-next-line no-empty-pattern
test.beforeAll(({}, testInfo) => {
  if (testInfo.retry === 0) {
    throw new Error('flaky beforeAll failure')
  }
})

test('should pass after beforeAll recovers', () => {})
