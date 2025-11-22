'use strict'

const assert = require('node:assert/strict')

let counter = 0

describe('test-flaky-test-retries', () => {
  it('can retry flaky tests', () => {
    assert.deepStrictEqual(++counter, 3)
  })

  it('will not retry passed tests', () => {
    assert.deepStrictEqual(3, 3)
  })
})
