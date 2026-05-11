'use strict'

/* eslint-disable import/order, n/no-missing-require, n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('node:test')
const tracer = require('dd-trace')

const attempts = {}
const hookAttempts = {}

function attempt (name) {
  attempts[name] = (attempts[name] || 0) + 1
  return attempts[name]
}

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

describe('early flake detection', () => {
  it('retries new tests with intermittent failures', () => {
    if (attempt('intermittent') === 1) {
      assert.fail('first attempt fails')
    }
  })

  it('does not retry known tests', () => {
    assert.strictEqual(attempt('known'), 1)
  })
})
