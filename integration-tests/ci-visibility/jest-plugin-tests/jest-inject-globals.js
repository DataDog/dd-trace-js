'use strict'

const assert = require('node:assert/strict')

const { describe, it, expect } = require('@jest/globals')

describe('jest-inject-globals', () => {
  it('will be run', () => {
    assert.deepStrictEqual(true, true)
  })
})
