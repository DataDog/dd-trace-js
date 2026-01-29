'use strict'

const assert = require('assert')
describe('partial quarantine tests', () => {
  it('quarantined failing test', () => {
    // This test fails but is quarantined, so it should not affect the session status
    assert.strictEqual(1 + 2, 4)
  })

  it('non-quarantined failing test', () => {
    // This test fails and is NOT quarantined, so it should cause the session to fail
    assert.strictEqual(1 + 2, 5)
  })

  it('passing test', () => {
    assert.strictEqual(1 + 2, 3)
  })
})
