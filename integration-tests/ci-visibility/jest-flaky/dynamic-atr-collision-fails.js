'use strict'

const assert = require('node:assert/strict')

let hasWaitedForSlowFirstAttempt = false

describe('dynamic ATR collision', () => {
  it('retries with the duration budget for this run', () => {
    if (process.env.JEST_RUN_INDEX !== '2' && !hasWaitedForSlowFirstAttempt) {
      hasWaitedForSlowFirstAttempt = true
      return new Promise(resolve => setTimeout(resolve, 5_100)).then(() => assert.fail('first run failure'))
    }
    assert.fail('second run failure')
  }, 6_000)
})
