'use strict'

const assert = require('node:assert/strict')

const sum = require('./src/run-dependency')

describe('test-run', () => {
  it('covers the run dependency', () => {
    assert.strictEqual(sum(1, 2), 3)
  })
})
