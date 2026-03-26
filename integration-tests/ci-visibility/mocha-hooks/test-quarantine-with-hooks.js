'use strict'

const assert = require('assert')

describe('quarantine tests with hooks', () => {
  beforeEach(() => {
    // setup
  })

  afterEach(() => {
    // teardown
  })

  it('can quarantine a test with hooks', () => {
    assert.strictEqual(1 + 2, 4) // intentionally fails
  })

  it('can pass normally with hooks', () => {
    assert.strictEqual(1 + 2, 3)
  })
})
