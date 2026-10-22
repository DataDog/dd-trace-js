'use strict'

const assert = require('node:assert/strict')

require('./shared-root-hooks')

it('retains shared setup for root-level tests', () => {
  assert.strictEqual(global.sharedBeforeRan, true)
  assert.strictEqual(global.sharedBeforeEachRan, true)
})

describe('retained nested tests', () => {
  it('retains shared setup for nested tests', () => {
    assert.strictEqual(global.sharedBeforeRan, true)
    assert.strictEqual(global.sharedBeforeEachRan, true)
  })
})
