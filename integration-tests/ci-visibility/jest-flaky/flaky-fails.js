'use strict'

const assert = require('node:assert/strict')

describe('test-flaky-test-retries', () => {
  it('can retry failed tests', () => {
    assert.deepStrictEqual(1, 2)
  })
})
