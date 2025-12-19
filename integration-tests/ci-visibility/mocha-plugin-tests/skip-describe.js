'use strict'

const assert = require('assert')
describe('mocha-test-skip-describe', () => {
  before(function () {
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
