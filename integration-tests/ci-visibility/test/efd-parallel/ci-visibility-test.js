'use strict'

const assert = require('node:assert')
const sum = require('../sum')

describe('ci visibility', () => {
  it('can report tests', () => {
    assert.strictEqual(sum(1, 2), 3)
  })
})
