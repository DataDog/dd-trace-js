'use strict'

const assert = require('node:assert')
const sum = require('../sum')

describe('ci visibility 3', () => {
  it('can report tests 3', () => {
    assert.strictEqual(sum(1, 2), 3)
  })
})
