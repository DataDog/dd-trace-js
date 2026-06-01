'use strict'

const assert = require('assert')
let counter = 0

describe('mocha-hooks flaky-passes', () => {
  beforeEach(() => {
    // setup
  })

  afterEach(() => {
    // teardown
  })

  it('can retry flaky tests', () => {
    assert.strictEqual(++counter, 2)
  })

  it('will not retry passed tests', () => {
    assert.ok(true)
  })
})
