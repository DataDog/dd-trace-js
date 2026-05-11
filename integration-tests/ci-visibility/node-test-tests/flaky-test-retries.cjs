'use strict'

/* eslint-disable import/order, n/no-missing-require, n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('node:test')
const tracer = require('dd-trace')

const attempts = {
  eventuallyPasses: 0,
  neverPasses: 0,
}
const hookAttempts = {}

function incrementHookAttempt (testName, hookName) {
  hookAttempts[testName] = hookAttempts[testName] || {}
  hookAttempts[testName][hookName] = (hookAttempts[testName][hookName] || 0) + 1
  tracer.scope().active()?.setTag(`test.${hookName}_count`, String(hookAttempts[testName][hookName]))
}

beforeEach((testContext) => {
  incrementHookAttempt(testContext.name, 'before_each')
})

afterEach((testContext) => {
  incrementHookAttempt(testContext.name, 'after_each')
})

describe('flaky test retries', () => {
  it('can retry tests that eventually pass', () => {
    attempts.eventuallyPasses++
    assert.ok(attempts.eventuallyPasses >= 3)
  })

  it('can retry tests that never pass', () => {
    attempts.neverPasses++
    assert.strictEqual(1 + 1, 3)
  })

  it('does not retry if unnecessary', () => {
    assert.strictEqual(1 + 1, 2)
  })
})
