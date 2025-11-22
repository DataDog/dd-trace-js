'use strict'

const assert = require('node:assert/strict')
describe('mocha-test-done-fail', () => {
  it('can do failed tests with done', (done) => {
    setTimeout(() => {
      try {
        assert.strictEqual(true, false)
        done()
      } catch (e) {
        done(e)
      }
    }, 100)
  })
})
