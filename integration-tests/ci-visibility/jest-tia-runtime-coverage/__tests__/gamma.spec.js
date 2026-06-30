'use strict'

const assert = require('node:assert/strict')

const { aggregate } = require('../src/aggregator')

describe('gamma suite', () => {
  it('touches a transitive dependency graph', () => {
    assert.strictEqual(aggregate('gamma'), 'gamma:3:8')
  })
})
