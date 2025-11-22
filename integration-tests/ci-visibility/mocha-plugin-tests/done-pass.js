'use strict'

const assert = require('node:assert/strict')
describe('mocha-test-done-pass', () => {
  it('can do passed tests with done', (done) => {
    setTimeout(() => {
      try {
        assert.strictEqual(true, true)
        done()
      } catch (e) {
        done(e)
      }
    }, 100)
  })
})
