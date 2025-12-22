'use strict'

const assert = require('assert')
describe('mocha-test-suite-level-fail', function () {
  it('will pass', () => {
    assert.strictEqual(2, 2)
  })

  it('will fail', () => {
    assert.strictEqual(2, 8)
  })
})

describe('mocha-test-suite-level-pass', function () {
  it('will pass', () => {
    assert.strictEqual(2, 2)
  })

  it.skip('will skip', () => {
    assert.strictEqual(2, 2)
  })
})
