'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const QueryLifecycleAdapter = require('../../../src/events/database/query-lifecycle-adapter')

describe('QueryLifecycleAdapter', () => {
  it('translates query completion into trace manager calls', () => {
    const operation = {}
    const traceManager = createTraceManager(operation)
    const adapter = new QueryLifecycleAdapter(traceManager)
    const name = 'mysql.query'
    const options = {}
    const context = {}
    const metadata = { 'db.response.status_code': '200' }

    const token = adapter.start(name, options, context)
    adapter.complete(token, metadata)

    assert.strictEqual(token, operation)
    sinon.assert.calledOnceWithExactly(traceManager.start, name, options, context, context)
    sinon.assert.calledOnceWithExactly(traceManager.complete, operation, metadata)
    sinon.assert.notCalled(traceManager.fail)
  })

  it('translates query failure into one atomic trace-manager call', () => {
    const operation = {}
    const traceManager = createTraceManager(operation)
    const adapter = new QueryLifecycleAdapter(traceManager)
    const error = new Error('query failed')
    const metadata = { 'db.response.status_code': '500' }

    const token = adapter.start('mysql.query', {}, {})
    adapter.error(token, error, metadata)

    sinon.assert.calledOnceWithExactly(traceManager.fail, operation, error, metadata)
    sinon.assert.notCalled(traceManager.complete)
  })

  it('propagates atomic completion failures', () => {
    const operation = {}
    const traceManager = createTraceManager(operation)
    const adapter = new QueryLifecycleAdapter(traceManager)
    const error = new Error('update failed')
    traceManager.complete.throws(error)
    const token = adapter.start('mysql.query', {}, {})

    assert.throws(() => adapter.complete(token, {}), error)
    sinon.assert.calledOnceWithExactly(traceManager.complete, operation, {})
  })

  it('propagates atomic failure-recording failures', () => {
    const operation = {}
    const traceManager = createTraceManager(operation)
    const adapter = new QueryLifecycleAdapter(traceManager)
    const error = new Error('error recording failed')
    traceManager.fail.throws(error)
    const token = adapter.start('mysql.query', {}, {})

    const applicationError = new Error('query failed')
    assert.throws(() => adapter.error(token, applicationError), error)
    sinon.assert.calledOnceWithExactly(traceManager.fail, operation, applicationError, undefined)
  })
})

function createTraceManager (operation) {
  return {
    complete: sinon.stub(),
    fail: sinon.stub(),
    start: sinon.stub().returns(operation),
  }
}
