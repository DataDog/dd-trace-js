'use strict'

const assert = require('node:assert/strict')

const sum = require('./dependency')

let attempts = 0

describe('WebdriverIO Failed Test Replay', () => {
  it('captures the failure on retry', () => {
    if (attempts++ === 0) {
      sum(11, 3)
    }

    assert.throws(() => sum(11, 3), /a is too big/)
    assert.strictEqual(sum(1, 3), 4)
  })
})
