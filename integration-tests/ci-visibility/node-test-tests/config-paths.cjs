'use strict'

/* eslint-disable n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

describe('node test config paths', () => {
  it('reports a passing test for config assertions', () => {
    assert.strictEqual(1 + 1, 2)
  })
})
