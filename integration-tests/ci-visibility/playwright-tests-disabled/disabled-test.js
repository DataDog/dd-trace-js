'use strict'

const { test, expect } = require('@playwright/test')

test('executes the test body', () => {
  process.stdout.write('PLAYWRIGHT_TEST_EXECUTED\n')
  expect(process.env.TEST_SHOULD_FAIL).toBe('false')
})
