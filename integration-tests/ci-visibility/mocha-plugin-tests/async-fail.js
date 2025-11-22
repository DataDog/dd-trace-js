'use strict'

const assert = require('node:assert/strict')
describe('mocha-test-async-fail', () => {
  it('can do failed async tests', async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    assert.strictEqual(true, false)
  })
})
