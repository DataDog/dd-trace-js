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

    const operation = manager.start(plan.name, plan.options, context)

    assert.deepStrictEqual(operation, {})
    assert.strictEqual(Object.isFrozen(operation), true)
    assert.strictEqual(Object.hasOwn(operation, 'span'), false)
    sinon.assert.calledOnceWithExactly(plugin.startSpan, plan.name, plan.options, context)
    assert.strictEqual(context.currentStore.span, span)
  })

  it('keeps concurrent operations isolated', () => {
    const firstSpan = { addTags: sinon.stub(), finish: sinon.stub() }
    const secondSpan = { addTags: sinon.stub(), finish: sinon.stub() }
    const plugin = createPlugin()
    plugin.startSpan.onFirstCall().returns(firstSpan)
    plugin.startSpan.onSecondCall().returns(secondSpan)
    const manager = new TraceManager(plugin)
    const first = manager.start('first', {}, {})
    const second = manager.start('second', {}, {})

    manager.complete(second, { status: 'second' })
    manager.complete(first, { status: 'first' })

    sinon.assert.calledOnceWithExactly(firstSpan.addTags, { status: 'first' })
    sinon.assert.calledOnceWithExactly(secondSpan.addTags, { status: 'second' })
    assert.deepStrictEqual(plugin.finishSpan.args, [[secondSpan], [firstSpan]])
  })

  it('keeps thousands of concurrent operations isolated', () => {
    const spans = []
    const plugin = createPlugin()
    plugin.startSpan.callsFake(() => {
      const span = { addTags: sinon.stub(), finish: sinon.stub() }
      spans.push(span)
      return span
    })
    const manager = new TraceManager(plugin)
    const operations = new Array(1000)

    for (let i = 0; i < operations.length; i++) {
      operations[i] = manager.start('database.query', {}, {})
    }
    for (let i = operations.length - 1; i >= 0; i--) {
      manager.complete(operations[i], { index: i })
    }

    assert.strictEqual(plugin.finishSpan.callCount, operations.length)
    for (let i = 0; i < spans.length; i++) {
      sinon.assert.calledOnceWithExactly(spans[i].addTags, { index: i })
      sinon.assert.calledOnce(spans[i].finish)
    }
  })

  it('uses an existing lifecycle identity without exposing its span', () => {
    const { manager, span } = createManager()
    const context = {}

    assert.strictEqual(manager.start('database.query', {}, context, context), context)
    assert.strictEqual(Object.hasOwn(context, 'span'), false)

    manager.complete(context, { status: 'complete' })

    sinon.assert.calledOnceWithExactly(span.addTags, { status: 'complete' })
  })

  it('records errors against the operation span', () => {
    const { manager, plugin, span } = createManager()
    const error = new Error('query failed')
    const operation = manager.start('database.query', {}, {})

    manager.fail(operation, error)

    sinon.assert.calledOnceWithExactly(plugin.addError, error, span)
    sinon.assert.calledOnceWithExactly(plugin.finishSpan, span)
  })

  it('owns propagation and data-streams access without exposing the operation span', () => {
    const { manager, plugin, span } = createManager()
    const operation = manager.start('messaging.produce', {}, {})
    const carrier = {}
    const parent = { parent: true }
    const pathway = { pathway: true }
    plugin.tracer.extract.returns(parent)
    plugin.tracer.decodeDataStreamsContext.returns(pathway)
    plugin.tracer.setCheckpoint.returns(pathway)

    manager.inject(operation, 'text_map', carrier)
    assert.strictEqual(manager.extract('text_map', carrier), parent)
    assert.strictEqual(manager.decodeDataStreamsContext(carrier), pathway)
    assert.strictEqual(manager.setCheckpoint(operation, ['direction:out'], 42), pathway)

    sinon.assert.calledOnceWithExactly(plugin.tracer.inject, span, 'text_map', carrier)
    sinon.assert.calledOnceWithExactly(plugin.tracer.extract, 'text_map', carrier)
    sinon.assert.calledOnceWithExactly(plugin.tracer.decodeDataStreamsContext, carrier)
    sinon.assert.calledOnceWithExactly(plugin.tracer.setCheckpoint, ['direction:out'], span, 42)
  })

  it('ignores operation-scoped capabilities after terminal cleanup', () => {
    const { manager, plugin } = createManager()
    const operation = manager.start('messaging.produce', {}, {})

    manager.complete(operation)
    manager.inject(operation, 'text_map', {})
    assert.strictEqual(manager.setCheckpoint(operation, ['direction:out'], 0), undefined)

    sinon.assert.notCalled(plugin.tracer.inject)
    sinon.assert.notCalled(plugin.tracer.setCheckpoint)
  })

  it('finishes once and ignores terminal work after state is released', () => {
    const { manager, plugin, span } = createManager()
    const context = {}
    const operation = manager.start('database.query', {}, context)

    manager.complete(operation)
    manager.complete(operation, { ignored: true })
    manager.fail(operation, new Error('ignored'))

    sinon.assert.calledOnceWithExactly(plugin.finishSpan, span)
    sinon.assert.calledOnce(span.finish)
    sinon.assert.notCalled(span.addTags)
    sinon.assert.notCalled(plugin.addError)
  })

  it('finishes without metadata and ignores unknown operation tokens', () => {
    const { manager, plugin, span } = createManager()
    const operation = manager.start('database.query', {}, {})

    manager.complete(operation, undefined)
    manager.complete({}, { ignored: true })
    manager.fail({}, new Error('ignored'))

    sinon.assert.notCalled(span.addTags)
    sinon.assert.notCalled(plugin.addError)
    sinon.assert.calledOnceWithExactly(plugin.finishSpan, span)
    sinon.assert.calledOnce(span.finish)
  })
})

function createManager () {
  const span = { addTags: sinon.stub(), finish: sinon.stub() }
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
    finishSpan: sinon.stub().callsFake(span => span.finish()),
    startSpan: sinon.stub(),
    tracer: {
      decodeDataStreamsContext: sinon.stub(),
      extract: sinon.stub(),
      inject: sinon.stub(),
      setCheckpoint: sinon.stub(),
    },
  }
}
