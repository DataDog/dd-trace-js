'use strict'

/* eslint-disable n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

describe('node test multi file second', () => {
  it('reports the second file', () => {
    assert.strictEqual(2 + 2, 4)
  })
})
