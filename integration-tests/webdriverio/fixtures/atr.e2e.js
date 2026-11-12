'use strict'

const assert = require('node:assert/strict')

let attempts = 0

describe('WebdriverIO ATR', () => {
  it('passes on retry', () => {
    assert.strictEqual(attempts++, 1)
  })
})
