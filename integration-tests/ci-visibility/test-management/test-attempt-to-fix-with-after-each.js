'use strict'

const assert = require('assert')

describe('attempt to fix tests', () => {
  afterEach(() => {
  })

  it('can attempt to fix a test that always passes', () => {
    assert.strictEqual(1 + 2, 3)
  })
  it('can attempt to fix a test that always fails', () => {
    assert.strictEqual(1 + 2, 4)
  })
})
