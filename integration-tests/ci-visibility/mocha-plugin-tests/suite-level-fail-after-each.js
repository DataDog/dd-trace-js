'use strict'

const assert = require('assert')
describe('mocha-test-suite-level-pass', function () {
  it('will pass', () => {
    assert.strictEqual(2, 2)
  })
})

describe('mocha-test-suite-level-fail', function () {
  afterEach(() => {
    throw new Error()
  })

  it('will pass', () => {
    assert.strictEqual(2, 2)
  })
})
