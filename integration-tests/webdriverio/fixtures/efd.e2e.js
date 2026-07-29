'use strict'

const assert = require('node:assert/strict')

let attempts = 0

describe('WebdriverIO EFD', () => {
  it('retries a new test', () => {
    assert.strictEqual(attempts++ % 2, 1)
  })
})
