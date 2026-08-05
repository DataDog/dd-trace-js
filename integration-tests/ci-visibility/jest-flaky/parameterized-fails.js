'use strict'

const assert = require('node:assert/strict')

describe('test-flaky-test-retries', () => {
  test.each([
    ['passing row', true],
    ['failing row', false],
  ])('preserves parameters between retries', (row, shouldPass) => {
    assert.strictEqual(shouldPass, true, row)
  })
})
