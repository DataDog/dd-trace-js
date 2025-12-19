'use strict'

const assert = require('assert')
describe('mocha-test-done-fail', () => {
  it('can do badly setup failed tests with done', (done) => {
    setTimeout(() => {
      assert.strictEqual(true, false)
      done()
    }, 100)
  })
})
