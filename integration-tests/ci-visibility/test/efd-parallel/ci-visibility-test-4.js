'use strict'

const assert = require('assert')

const sum = require('../sum')

describe('ci visibility 4', () => {
  it('can report tests 4', () => {
    assert.deepStrictEqual(sum(1, 2), 3)
  })
})
