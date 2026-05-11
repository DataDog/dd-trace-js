'use strict'

/* eslint-disable n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

describe('node test multi file first', () => {
  it('reports the first file', () => {
    assert.strictEqual(1 + 1, 2)
  })
})
