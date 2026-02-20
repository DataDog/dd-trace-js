'use strict'

const assert = require('assert')

describe('multiple quarantine tests', () => {
  it('first failing test', () => {
    assert.strictEqual(1 + 2, 4) // always fails
  })

  it('second failing test', () => {
    assert.strictEqual(1 + 2, 5) // always fails
  })

  it('passing test', () => {
    assert.strictEqual(1 + 2, 3) // always passes
  })
})
