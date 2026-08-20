'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const TraceManager = require('../../src/events/trace-manager')

describe('TraceManager', () => {
  it('starts an operation without exposing its span', () => {
    const { manager, plugin, span } = createManager()
    const plan = {
      name: 'database.query',
      options: { resource: 'SELECT 1', type: 'sql' },
    }
    const context = {}

    const operation = manager.start(plan, context)

    assert.deepStrictEqual(operation, {})
    assert.strictEqual(Object.isFrozen(operation), true)
    assert.strictEqual(Object.hasOwn(operation, 'span'), false)
    sinon.assert.calledOnceWithExactly(plugin.startSpan, plan.name, plan.options, context)
    assert.strictEqual(context.currentStore.span, span)
  })

  it('keeps concurrent operations isolated', () => {
    const firstSpan = { addTags: sinon.stub() }
    const secondSpan = { addTags: sinon.stub() }
    const plugin = createPlugin()
    plugin.startSpan.onFirstCall().returns(firstSpan)
    plugin.startSpan.onSecondCall().returns(secondSpan)
    const manager = new TraceManager(plugin)
    const first = manager.start({ name: 'first', options: {} }, {})
    const second = manager.start({ name: 'second', options: {} }, {})

    manager.update(second, { status: 'second' })
    manager.update(first, { status: 'first' })

    sinon.assert.calledOnceWithExactly(firstSpan.addTags, { status: 'first' })
    sinon.assert.calledOnceWithExactly(secondSpan.addTags, { status: 'second' })
  })

  it('records errors against the operation span', () => {
    const { manager, plugin, span } = createManager()
    const error = new Error('query failed')
    const operation = manager.start({ name: 'database.query', options: {} }, {})

    manager.error(operation, error)

    sinon.assert.calledOnceWithExactly(plugin.addError, error, span)
  })

  it('finishes once and ignores terminal work after state is released', () => {
    const { manager, plugin, span } = createManager()
    const context = {}
    const operation = manager.start({ name: 'database.query', options: {} }, context)

    manager.finish(operation)
    manager.update(operation, { ignored: true })
    manager.error(operation, new Error('ignored'))
    manager.finish(operation)

    sinon.assert.calledOnceWithExactly(plugin.finish, context)
    sinon.assert.notCalled(span.addTags)
    sinon.assert.notCalled(plugin.addError)
  })

  it('ignores missing metadata and unknown operation tokens', () => {
    const { manager, plugin, span } = createManager()
    const operation = manager.start({ name: 'database.query', options: {} }, {})

    manager.update(operation, undefined)
    manager.update({}, { ignored: true })
    manager.error({}, new Error('ignored'))
    manager.finish({})

    sinon.assert.notCalled(span.addTags)
    sinon.assert.notCalled(plugin.addError)
    sinon.assert.notCalled(plugin.finish)
  })
})

function createManager () {
  const span = { addTags: sinon.stub() }
  const plugin = createPlugin()
  plugin.startSpan.callsFake((name, options, context) => {
    context.currentStore = { span }
    return span
  })

  return { manager: new TraceManager(plugin), plugin, span }
}

function createPlugin () {
  return {
    addError: sinon.stub(),
    finish: sinon.stub(),
    startSpan: sinon.stub(),
  }
}
