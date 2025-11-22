'use strict'

const assert = require('node:assert/strict')
describe('dynamic-instrumentation 2', () => {
  it('is not retried', () => {
    assert.strictEqual(1 + 2, 3)
  })
})
