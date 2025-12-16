'use strict'

const assert = require('assert')

const sum = require('./dependency')
describe('dynamic-instrumentation', () => {
  it('retries with DI', function () {
    assert.strictEqual(sum(11, 3), 14)
  })

  it('is not retried', () => {
    assert.strictEqual(1 + 2, 3)
  })
})
