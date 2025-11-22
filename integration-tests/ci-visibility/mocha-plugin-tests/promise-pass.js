'use strict'

const assert = require('node:assert/strict')
describe('mocha-test-promise-pass', () => {
  it('can do passed promise tests', () => {
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(true, true)
        resolve()
      }, 100)
    })
  })
})
