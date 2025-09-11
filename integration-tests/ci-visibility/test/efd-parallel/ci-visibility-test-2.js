'use strict'

const assert = require('node:assert')
const sum = require('../sum')

describe('ci visibility 2', () => {
  it('can report tests 2', () => {
    assert.strictEqual(sum(1, 2), 3)
  })
})
