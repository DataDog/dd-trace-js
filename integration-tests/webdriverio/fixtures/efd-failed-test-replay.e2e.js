'use strict'

const assert = require('node:assert/strict')

const sum = require('./dependency')

let attempts = 0

describe('WebdriverIO EFD Failed Test Replay', () => {
  it('captures a failure after a passing attempt', () => {
    const attempt = attempts++
    if (attempt === 0) {
      assert.strictEqual(sum(1, 3), 4)
      return
    }
    if (attempt === 1) {
      sum(11, 3)
    }

    assert.throws(() => sum(11, 3), /a is too big/)
  })
})
