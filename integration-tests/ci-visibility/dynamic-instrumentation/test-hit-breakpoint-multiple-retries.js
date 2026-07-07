'use strict'

const assert = require('assert')

const sum = require('./dependency')
let count = 0

describe('dynamic-instrumentation', () => {
  it('retries with DI across multiple failures', function () {
    if (count++ < 3) {
      assert.strictEqual(sum(11, 3), 14)
    }
    assert.strictEqual(sum(1, 3), 4)
  })
})
