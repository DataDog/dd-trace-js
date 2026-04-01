'use strict'

const assert = require('assert')

describe('attempt to fix parallel tests 1', () => {
  it('can attempt to fix a test', () => {
    assert.strictEqual(1 + 2, 4)
  })
})
