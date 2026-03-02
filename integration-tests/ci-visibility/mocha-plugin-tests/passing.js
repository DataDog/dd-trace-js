'use strict'

const assert = require('assert')
describe('mocha-test-pass', () => {
  it('can pass', () => {
    assert.strictEqual(true, true)
  })

  it('can pass two', () => {
    assert.strictEqual(true, true)
  })
})

describe('mocha-test-pass-two', () => {
  it('can pass', () => {
    assert.strictEqual(true, true)
  })

  it('can pass two', () => {
    assert.strictEqual(true, true)
  })
})
