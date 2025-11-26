'use strict'

const assert = require('assert')
describe('mocha-test-skip', () => {
  it.skip('can skip', () => {
    assert.strictEqual(true, false)
  })
})

describe('mocha-test-skip-different', () => {
  it.skip('can skip too', () => {
    assert.strictEqual(true, false)
  })

  it.skip('can skip twice', () => {
    assert.strictEqual(true, false)
  })
})

describe('mocha-test-programmatic-skip', () => {
  it('can skip too', function () {
    this.skip()
  })
})
