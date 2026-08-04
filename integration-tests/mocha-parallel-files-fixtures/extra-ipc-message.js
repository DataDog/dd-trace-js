'use strict'

const assert = require('node:assert/strict')

before(() => {
  if (typeof process.send === 'function') {
    process.send({ type: 'unrelated-noise', stamp: Date.now() })
  }
})

describe('extra-ipc-message fixture', () => {
  it('passes after an unrelated IPC payload', () => {
    assert.strictEqual(1, 1)
  })
})
