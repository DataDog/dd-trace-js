'use strict'

const assert = require('assert')
describe('worker restart impacted tests', () => {
  it('can pass normally', () => {
    assert.strictEqual(1 + 2, 3)
  })
})
