'use strict'

const assert = require('assert')

const sum = require('../sum')

describe('ci visibility', () => {
  it('can report tests', () => {
    assert.deepStrictEqual(sum(1, 2), 3)
  })
})
