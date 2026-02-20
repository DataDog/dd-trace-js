'use strict'

const assert = require('assert')

describe('quarantine tests with afterAll failure', () => {
  afterAll(() => {
    throw new Error('afterAll always fails') // simulates a cleanup failure
  })

  it('failing quarantined test', () => {
    assert.strictEqual(1 + 2, 4) // always fails
  })
})
