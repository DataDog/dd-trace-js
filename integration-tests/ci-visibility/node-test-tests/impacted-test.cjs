'use strict'

/* eslint-disable n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

describe('impacted test', () => {
  it('can mark impacted tests', () => {
    assert.strictEqual(1 + 1, 2)
  })
})
