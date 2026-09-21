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
    if (process.env.DYNAMIC_ATR_HOOK_FAILURE === 'beforeEach' && this.currentTest.currentRetry() === 1) {
      assert.fail('retry beforeEach failed')
    }
  })

  afterEach(function () {
    if (process.env.DYNAMIC_ATR_HOOK_FAILURE === 'afterEach' && this.currentTest.currentRetry() === 1) {
      assert.fail('retry afterEach failed')
    }
  })

  it('uses the duration budget', function () {
    if (this.test.currentRetry() === 1 &&
      (process.env.DYNAMIC_ATR_RECOVER || process.env.DYNAMIC_ATR_HOOK_FAILURE === 'afterEach')) return
    assert.fail('test body failed')
  })
})
