'use strict'

const { test, expect } = require('@playwright/test')
const { noAutoRetry } = require('dd-trace/test-optimization')

test('keeps explicit retries after disabling tracing', noAutoRetry(() => {
  process.stdout.write('PLAYWRIGHT_EXCLUDED_TEST_EXECUTED\n')
  expect(false).toBe(true)
}))
