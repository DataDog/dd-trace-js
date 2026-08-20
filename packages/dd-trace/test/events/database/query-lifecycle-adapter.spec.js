'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const QueryLifecycleAdapter = require('../../../src/events/database/query-lifecycle-adapter')

describe('QueryLifecycleAdapter', () => {
  it('translates query completion into trace manager calls', () => {
    const adapter = new QueryLifecycleAdapter()
    const operation = {}
    const traceManager = createTraceManager(operation)
    const plan = { name: 'mysql.query', options: {} }
    const context = {}
    const facts = { statement: 'SELECT 1' }
    const metadata = { 'db.response.status_code': '200' }

    const token = adapter.start({ traceManager, plan, context, facts })
    adapter.complete(token, metadata)

    assert.strictEqual(token.facts, facts)
    sinon.assert.calledOnceWithExactly(traceManager.start, plan, context)
    sinon.assert.calledOnceWithExactly(traceManager.update, operation, metadata)
    sinon.assert.calledOnceWithExactly(traceManager.finish, operation)
    sinon.assert.notCalled(traceManager.error)
  })

  it('translates query failure into update, error, and finish calls', () => {
    const adapter = new QueryLifecycleAdapter()
    const operation = {}
    const traceManager = createTraceManager(operation)
    const error = new Error('query failed')
    const metadata = { 'db.response.status_code': '500' }

    const token = adapter.start({
      traceManager,
      plan: { name: 'mysql.query', options: {} },
      context: {},
      facts: {},
    })
    adapter.error(token, error, metadata)

    sinon.assert.callOrder(traceManager.update, traceManager.error, traceManager.finish)
    sinon.assert.calledOnceWithExactly(traceManager.update, operation, metadata)
    sinon.assert.calledOnceWithExactly(traceManager.error, operation, error)
    sinon.assert.calledOnceWithExactly(traceManager.finish, operation)
  })

  it('finishes when completion metadata cannot be applied', () => {
    const adapter = new QueryLifecycleAdapter()
    const operation = {}
    const traceManager = createTraceManager(operation)
    const error = new Error('update failed')
    traceManager.update.throws(error)
    const token = adapter.start({
      traceManager,
      plan: { name: 'mysql.query', options: {} },
      context: {},
      facts: {},
    })

    assert.throws(() => adapter.complete(token, {}), error)
    sinon.assert.calledOnceWithExactly(traceManager.finish, operation)
  })

  it('finishes when error recording fails', () => {
    const adapter = new QueryLifecycleAdapter()
    const operation = {}
    const traceManager = createTraceManager(operation)
    const error = new Error('error recording failed')
    traceManager.error.throws(error)
    const token = adapter.start({
      traceManager,
      plan: { name: 'mysql.query', options: {} },
      context: {},
      facts: {},
    })

    assert.throws(() => adapter.error(token, new Error('query failed')), error)
    sinon.assert.calledOnceWithExactly(traceManager.finish, operation)
  })
})

function createTraceManager (operation) {
  return {
    error: sinon.stub(),
    finish: sinon.stub(),
    start: sinon.stub().returns(operation),
    update: sinon.stub(),
  }
}
