'use strict'

const assert = require('node:assert/strict')

const sum = require('./dependency')
let count = 0

describe('dynamic-instrumentation', () => {
  it('retries with DI', function () {
    if (process.env.TEST_SHOULD_PASS_AFTER_RETRY && count++ === 1) {
      // Passes after a retry if TEST_SHOULD_PASS_AFTER_RETRY is passed
      assert.strictEqual(sum(1, 3), 4)
    } else {
      assert.strictEqual(sum(11, 3), 14)
    }
  })

  it('is not retried', () => {
    assert.strictEqual(1 + 2, 3)
  })
})
