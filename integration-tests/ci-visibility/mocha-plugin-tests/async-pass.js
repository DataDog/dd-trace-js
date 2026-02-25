'use strict'

const assert = require('assert')
describe('mocha-test-async-pass', () => {
  it('can do passed async tests', async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    assert.strictEqual(true, true)
  })
})
