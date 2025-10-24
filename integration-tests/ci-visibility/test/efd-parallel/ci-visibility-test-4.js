'use strict'

const assert = require('node:assert')
const sum = require('../sum')

describe('ci visibility 4', () => {
  it('can report tests 4', () => {
    assert.strictEqual(sum(1, 2), 3)
  })
})
