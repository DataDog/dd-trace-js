'use strict'

const assert = require('node:assert/strict')

describe('fast check with seed', () => {
  it('should include seed (with seed=12)', () => {
    assert.deepStrictEqual(1 + 2, 3)
  })
})
