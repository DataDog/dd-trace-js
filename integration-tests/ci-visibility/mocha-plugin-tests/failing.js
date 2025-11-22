'use strict'

const assert = require('node:assert/strict')
describe('mocha-test-fail', () => {
  it('can fail', () => {
    assert.strictEqual(true, false)
  })
})
