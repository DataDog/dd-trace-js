'use strict'

const assert = require('assert')

describe('mocha-hooks flaky-fails', () => {
  beforeEach(() => {
    // setup
  })

  afterEach(() => {
    // teardown
  })

  it('can retry failed tests', () => {
    assert.strictEqual(1 + 2, 4) // intentionally fails
  })
})
