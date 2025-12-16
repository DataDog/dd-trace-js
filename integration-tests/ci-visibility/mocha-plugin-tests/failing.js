'use strict'

const assert = require('assert')
describe('mocha-test-fail', () => {
  it('can fail', () => {
    assert.strictEqual(true, false)
  })
})
