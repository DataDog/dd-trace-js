'use strict'

const assert = require('node:assert/strict')

const hookType = process.env.ROOT_HOOK_TYPE

global[hookType](function () {
  process.stdout.write(`file-owned ${hookType} hook\n`)
  if (process.env.ROOT_HOOK_FAIL === 'true') {
    assert.fail('This hook must be skipped by Test Impact Analysis')
  }
})

it('root-level test with a file-owned hook', () => {})

describe('nested tests with a file-owned root hook', () => {
  it('passes', () => {})
})
