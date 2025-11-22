'use strict'

const assert = require('node:assert/strict')
describe('mocha-fail-hook-sync', () => {
  beforeEach(() => {
    const value = ''
    value.unsafe.error = ''
  })

  it('will not run but be reported as failed', () => {
    assert.strictEqual(true, true)
  })
})
