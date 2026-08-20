'use strict'

const { test } = require('@playwright/test')

test.beforeAll((_fixtures, testInfo) => {
  if (testInfo.retry === 0) {
    throw new Error('flaky beforeAll failure')
  }
})

test('should pass after beforeAll recovers', () => {})
