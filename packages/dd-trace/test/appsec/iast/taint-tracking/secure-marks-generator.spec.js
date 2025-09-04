'use strict'

const { getNextSecureMark, reset } = require('../../../../src/appsec/iast/taint-tracking/secure-marks-generator')
const assert = require('node:assert')
const { describe, it, beforeEach } = require('mocha')

describe('test secure marks generator', () => {
  beforeEach(() => {
    reset()
  })

  after(() => {
    reset()
  })

  it('should generate numbers in order', () => {
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(getNextSecureMark(), (1 << i) >>> 0)
    }
  })
})
