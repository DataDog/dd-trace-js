'use strict'

const assert = require('node:assert/strict')

const durations = JSON.parse(process.env.DYNAMIC_ATR_DURATIONS)

describe('dynamic ATR duplicates', () => {
  beforeEach(function () {
    const test = this.currentTest
    process.stdout.write(`RETRY_BUDGET ${JSON.stringify([test.currentRetry(), test.retries()])}\n`)
  })

  for (const [index, duration] of durations.entries()) {
    it('uses its own duration budget', function () {
      // Retry durations cross buckets so only the first attempt can determine the budget.
      Object.defineProperty(this.test, 'duration', {
        configurable: true,
        get: () => this.test.currentRetry() === 0 ? duration : 15000,
        set: () => {},
      })
      assert.fail(`declaration ${index}`)
    })
  }
})
