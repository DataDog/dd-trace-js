'use strict'

/* eslint-disable n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

describe('attempt to fix', () => {
  it('can attempt to fix passing tests', () => {
    assert.ok(true)
  })

  it('can attempt to fix failing tests', () => {
    assert.fail('attempt failed')
  })

  it('can attempt to fix disabled tests', () => {
    assert.ok(true)
  })

  it('can attempt to fix quarantined failing tests', () => {
    assert.fail('quarantined attempt failed')
  })
})
