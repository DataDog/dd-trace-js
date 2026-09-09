'use strict'

const assert = require('assert')
describe('mocha-test-skip-describe', () => {
  before(function () {
    // This suite-level skip is fixture input for Test Optimization status reporting.
    this.skip()
  })

  it('will be skipped', () => {
    assert.strictEqual(true, true)
  })
})

describe('mocha-test-skip-describe-pass', () => {
  it('will pass', function () {
    assert.strictEqual(true, true)
  })
})
