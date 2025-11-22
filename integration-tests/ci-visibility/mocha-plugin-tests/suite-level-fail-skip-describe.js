'use strict'

const assert = require('node:assert/strict')
describe('mocha-test-suite-level-fail', function () {
  it('will pass', () => {
    assert.strictEqual(2, 2)
  })

  it('will fail', () => {
    assert.strictEqual(2, 8)
  })
})

describe.skip('mocha-test-suite-level-skip', function () {
  it('will pass', () => {
    assert.strictEqual(2, 2)
  })

  it('will fail', () => {
    assert.strictEqual(2, 8)
  })
})
