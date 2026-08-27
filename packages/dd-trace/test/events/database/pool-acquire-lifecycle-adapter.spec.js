'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const { PoolAcquireLifecycleAdapter } = require('../../../src/events/database')

describe('PoolAcquireLifecycleAdapter', () => {
  it('translates pool acquisition into trace-manager lifecycle calls', () => {
    const traceManager = {
      complete: sinon.stub(),
      fail: sinon.stub(),
      start: sinon.stub().returnsArg(3),
    }
    const adapter = new PoolAcquireLifecycleAdapter(traceManager)
    const error = new Error('acquire failed')
    const operation = {}
    const options = { resource: 'mariadb.pool.acquire' }

    assert.strictEqual(adapter.start('mariadb.pool.acquire', options, operation), operation)
    adapter.complete(operation, { 'mariadb.pool.wait_time': 12.5 })
    adapter.error(operation, error, { 'mariadb.pool.wait_time': 20 })

    sinon.assert.calledOnceWithExactly(
      traceManager.start,
      'mariadb.pool.acquire',
      options,
      operation,
      operation
    )
    sinon.assert.calledOnceWithExactly(
      traceManager.complete,
      operation,
      { 'mariadb.pool.wait_time': 12.5 }
    )
    assert.strictEqual(traceManager.fail.firstCall.args[0], operation)
    assert.strictEqual(traceManager.fail.firstCall.args[1], error)
    assert.deepStrictEqual(traceManager.fail.firstCall.args[2], { 'mariadb.pool.wait_time': 20 })
  })
})
