'use strict'

const assert = require('node:assert/strict')
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
