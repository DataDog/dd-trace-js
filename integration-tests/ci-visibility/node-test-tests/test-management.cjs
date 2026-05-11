'use strict'

/* eslint-disable n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

describe('test management', () => {
  it('can disable tests', () => {
    assert.fail('disabled test body should not run')
  })

  it('can quarantine tests', () => {
    assert.fail('quarantined failure')
  })

  it('passes normally', () => {
    assert.ok(true)
  })
})
