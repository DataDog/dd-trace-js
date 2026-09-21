'use strict'

const assert = require('node:assert/strict')

describe('dynamic ATR', () => {
  beforeEach(function () {
    // Select the first duration bucket deterministically without sleeping.
    Object.defineProperty(this.currentTest, 'duration', {
      configurable: true,
      get: () => 100,
      set: () => {},
    })
    if (process.env.DYNAMIC_ATR_HOOK_FAILURE && this.currentTest.currentRetry() === 1) {
      assert.fail('retry beforeEach failed')
    }
  })

  it('uses the duration budget', function () {
    if (process.env.DYNAMIC_ATR_RECOVER && this.test.currentRetry() === 1) return
    assert.fail('test body failed')
  })
})
