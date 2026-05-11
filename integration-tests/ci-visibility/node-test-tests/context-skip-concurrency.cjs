'use strict'

/* eslint-disable import/order, n/no-missing-require, n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const { describe, it, test } = require('node:test')
const tracer = require('dd-trace')

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('node test context controls', () => {
  it('reports context skip calls', (testContext) => {
    tracer.scope().active()?.setTag('test.context_skip', 'true')
    testContext.skip('programmatic skip')
  })

  test('reports context todo calls', (testContext) => {
    tracer.scope().active()?.setTag('test.context_todo', 'true')
    testContext.todo('programmatic todo')
  })

  it('keeps concurrent test span context isolated', { concurrency: true }, async () => {
    tracer.scope().active()?.setTag('test.concurrent', 'first')
    await wait(30)
    assert.strictEqual(tracer.scope().active()?.context()._tags['test.concurrent'], 'first')
  })

  it('keeps the second concurrent span isolated', { concurrency: true }, async () => {
    tracer.scope().active()?.setTag('test.concurrent', 'second')
    await wait(10)
    assert.strictEqual(tracer.scope().active()?.context()._tags['test.concurrent'], 'second')
  })
})
