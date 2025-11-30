'use strict'

const assert = require('assert')

const sum = require('./dependency')
let count = 0

describe('dynamic-instrumentation', () => {
  it('retries with DI', function () {
    const willFail = count++ === 0
    if (willFail) {
      assert.strictEqual(sum(11, 3), 14) // only throws the first time
    } else {
      assert.strictEqual(sum(1, 2), 3)
    }
  })
})
