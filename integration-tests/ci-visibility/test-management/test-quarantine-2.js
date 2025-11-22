'use strict'

const assert = require('node:assert/strict')
describe('quarantine tests 2', () => {
  it('can quarantine a test', () => {
    assert.strictEqual(1 + 2, 3)
  })

  it('can pass normally', () => {
    assert.strictEqual(1 + 2, 3)
  })
})
