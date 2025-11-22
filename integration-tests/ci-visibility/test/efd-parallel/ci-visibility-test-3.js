'use strict'

const assert = require('node:assert/strict')

const sum = require('../sum')

describe('ci visibility 3', () => {
  it('can report tests 3', () => {
    assert.deepStrictEqual(sum(1, 2), 3)
  })
})
