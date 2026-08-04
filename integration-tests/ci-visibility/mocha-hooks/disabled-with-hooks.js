'use strict'

const assert = require('assert')

describe('disable tests with hooks', () => {
  beforeEach(() => {
    // setup
  })

  afterEach(() => {
    // teardown
  })

  it('can disable a test with hooks', () => {
    assert.strictEqual(1 + 2, 4) // intentionally fails
  })
})
