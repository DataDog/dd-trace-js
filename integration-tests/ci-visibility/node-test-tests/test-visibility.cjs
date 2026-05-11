'use strict'

/* eslint-disable import/order, n/no-missing-require, n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const { beforeEach, afterEach, describe, it, test } = require('node:test')
const tracer = require('dd-trace')

beforeEach(() => {
  tracer.scope().active()?.setTag('test.before_each', 'true')
})

afterEach(() => {
  tracer.scope().active()?.setTag('test.after_each', 'true')
})

describe('node test visibility', () => {
  it('can report passed test', () => {
    tracer.scope().active()?.setTag('test.body', 'true')
    assert.strictEqual(1 + 1, 2)
  })

  it('can report failed test', () => {
    assert.strictEqual(1 + 1, 3)
  })

  test.skip('can report skipped test', () => {
    assert.fail('should not run')
  })
})
