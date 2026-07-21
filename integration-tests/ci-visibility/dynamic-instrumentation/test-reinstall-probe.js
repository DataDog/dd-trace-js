'use strict'

const assert = require('node:assert/strict')

const sum = require('./dependency')

let secondTestAttempt = 0

describe('dynamic-instrumentation', () => {
  it('exhausts retries for the first failure with DI', function () {
    assert.strictEqual(sum(11, 3), 14)
  })

  it('retries a later failure from the same location with DI', function () {
    const input = secondTestAttempt++ < 2 ? 11 : 1
    assert.strictEqual(sum(input, 3), input + 3)
  })
})
