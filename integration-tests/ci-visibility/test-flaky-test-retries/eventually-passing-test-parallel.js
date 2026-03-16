'use strict'

const assert = require('assert')
let counter = 0

describe('test-flaky-test-retries-parallel', () => {
  it('can retry failed tests', () => {
    assert.strictEqual(++counter, 3)
  })
})
