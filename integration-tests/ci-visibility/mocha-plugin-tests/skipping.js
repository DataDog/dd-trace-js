'use strict'

const assert = require('assert')
describe('mocha-test-skip', () => {
  // This skip is fixture input for Test Optimization status reporting.
  it.skip('can skip', () => {
    assert.strictEqual(true, false)
  })
})

describe('mocha-test-skip-different', () => {
  // This skip is fixture input for Test Optimization status reporting.
  it.skip('can skip too', () => {
    assert.strictEqual(true, false)
  })

  // This second skip verifies the reported skip cardinality.
  it.skip('can skip twice', () => {
    assert.strictEqual(true, false)
  })
})

describe('mocha-test-programmatic-skip', () => {
  it('can skip too', function () {
    // This programmatic skip is fixture input for Test Optimization status reporting.
    this.skip()
  })
})
