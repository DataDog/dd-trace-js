'use strict'

const assert = require('assert')
let numAttempts = 0

describe('attempt to fix tests that fail first', () => {
  it('can attempt to fix a test that fails first then passes', () => {
    assert.strictEqual(numAttempts++ > 0, true)
  })
})
