'use strict'

const assert = require('assert')

describe('test-flaky-test-retries', () => {
  it('can retry failed tests', () => {
    assert.deepStrictEqual(1, 2)
  })
})
