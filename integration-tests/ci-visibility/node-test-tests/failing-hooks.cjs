'use strict'

/* eslint-disable import/order, n/no-missing-require, n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('node:test')
const tracer = require('dd-trace')

beforeEach((testContext) => {
  if (testContext.name === 'reports beforeEach failures') {
    throw new Error('beforeEach hook failed')
  }
  tracer.scope().active()?.setTag('test.before_each', 'true')
})

afterEach((testContext) => {
  tracer.scope().active()?.setTag('test.after_each', 'true')
  if (testContext.name === 'reports afterEach failures') {
    throw new Error('afterEach hook failed')
  }
})

describe('node test failing hooks', () => {
  it('reports beforeEach failures', () => {
    assert.fail('test body should not run after beforeEach failure')
  })

  it('reports afterEach failures', () => {
    tracer.scope().active()?.setTag('test.body', 'afterEach')
    assert.strictEqual(1 + 1, 2)
  })

  it('reports passing tests after hook failures', () => {
    tracer.scope().active()?.setTag('test.body', 'pass')
    assert.strictEqual(2 + 2, 4)
  })
})
