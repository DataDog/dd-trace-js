'use strict'

const assert = require('node:assert/strict')

let numAfterEachRuns = 0

describe('attempt to fix tests with failing afterEach', () => {
  afterEach(() => {
    if (numAfterEachRuns++ === 1) {
      assert.strictEqual(1 + 2, 4)
    }
  })

  it('can attempt to fix a test whose afterEach fails before the last attempt', () => {
    assert.strictEqual(1 + 2, 3)
  })
})
