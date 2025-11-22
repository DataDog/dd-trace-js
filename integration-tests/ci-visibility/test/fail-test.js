'use strict'

const assert = require('node:assert/strict')
describe('fail', () => {
  it('can report failed tests', () => {
    assert.strictEqual(1 + 2, 4)
  })
})
