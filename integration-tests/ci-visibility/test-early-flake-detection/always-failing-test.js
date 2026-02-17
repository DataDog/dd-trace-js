'use strict'

const assert = require('assert')

describe('fail', () => {
  it('always fails', () => {
    assert.strictEqual(1, 2)
  })
})
