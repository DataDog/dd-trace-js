'use strict'

/* eslint-disable import/order, n/no-missing-require, n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('node:test')
const tracer = require('dd-trace')

beforeEach(() => {
  tracer.scope().active()?.setTag('test.before_each', 'true')
})

afterEach((testContext) => {
  tracer.scope().active()?.setTag('test.after_each', 'true')
  if (testContext.name === 'can quarantine a test whose afterEach hook fails') {
    throw new Error('afterEach hook failed')
  }
})

describe('node test management with hooks', () => {
  it('can disable a failing test with hooks', () => {
    assert.fail('disabled test body should not run')
  })

  it('can quarantine a failing test with hooks', () => {
    assert.fail('quarantined body failed')
  })

  it('can quarantine a test whose afterEach hook fails', () => {
    assert.strictEqual(1 + 1, 2)
  })
})
