'use strict'

const assert = require('assert')
describe('impacted tests 2', () => {
  it('can pass normally', () => {
    assert.strictEqual(1 + 2, 3)
  })

  it('can fail', () => {
    assert.strictEqual(1 + 2, 4)
  })
})
