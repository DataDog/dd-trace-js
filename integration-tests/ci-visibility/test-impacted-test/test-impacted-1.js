'use strict'

const assert = require('assert')
describe('impacted tests', () => {
  it('can pass normally', () => {
    assert.strictEqual(1 + 2, 3)
  })

  it('can fail', () => {
    assert.strictEqual(1 + 2, 4)
  })
})
