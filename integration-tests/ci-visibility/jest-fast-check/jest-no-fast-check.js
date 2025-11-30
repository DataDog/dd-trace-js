'use strict'

const assert = require('assert')

describe('fast check with seed', () => {
  it('should include seed (with seed=12)', () => {
    assert.deepStrictEqual(1 + 2, 3)
  })
})
