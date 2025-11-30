'use strict'

const assert = require('assert')
describe('fail', () => {
  it('can report failed tests', () => {
    assert.strictEqual(1 + 2, 4)
  })
})
