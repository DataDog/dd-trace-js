'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../setup/core')

const { storage } = require('../../../datadog-core')
const { SemanticLifecycleBridge } = require('../../src/events/bridge')
const { createLifecycleChannels } = require('../../src/events/lifecycle')
const { EventSourceRegistry } = require('../../src/events/source-registry')

const legacyStorage = storage('legacy')
const bindings = []
const subscriptions = []
let channelId = 0

describe('SemanticLifecycleBridge', () => {
  afterEach(() => {
    for (const channel of bindings) channel.unbindStore(legacyStorage)
    for (const [channel, handler] of subscriptions) channel.unsubscribe(handler)
    bindings.length = 0
    subscriptions.length = 0
    legacyStorage.enterWith(undefined)
  })

  it('normalizes the source context in place and composes contributor and processor stores', () => {
    const sourceRegistry = new EventSourceRegistry()
    const channels = createChannels()
    const parentStore = { parent: true }
    const contributorStore = { contributor: true }
    const processorStore = { processor: true }
    const context = { arguments: ['SELECT 1'] }
    const normalize = sinon.spy(event => {
      event.source = { integration: 'mysql', system: 'mysql' }
      event.data = { statement: event.arguments[0] }
      return event
    })
    const contributorStart = sinon.stub().returns(contributorStore)
    const processorStart = sinon.stub().returns(processorStore)

    sourceRegistry.registerContributor('db.query', 'iast', { start: contributorStart })
    channels.start.bindStore(legacyStorage, processorStart)
    bindings.push(channels.start)

    const bridge = new SemanticLifecycleBridge({
      operation: 'db.query',
      channels,
      normalize,
      sourceRegistry,
    })

    let store
    legacyStorage.run(parentStore, () => {
      store = bridge.start(context)
    })

    assert.strictEqual(store, processorStore)
    assert.strictEqual(context.parentStore, parentStore)
    assert.strictEqual(context.data.statement, 'SELECT 1')
    sinon.assert.calledOnceWithExactly(normalize, context)
    sinon.assert.calledOnceWithExactly(contributorStart, context, parentStore)
    sinon.assert.calledOnceWithExactly(processorStart, context)

    assert.strictEqual(bridge.start(context), processorStore)
    sinon.assert.calledOnce(normalize)
    sinon.assert.calledOnce(contributorStart)
    sinon.assert.calledOnce(processorStart)
  })

  it('publishes error and finish exactly once under the processor store', () => {
    const sourceRegistry = new EventSourceRegistry()
    const channels = createChannels()
    const parentStore = { parent: true }
    const processorStore = { processor: true }
    const errorStore = { error: true }
    const callbackStore = { callback: true }
    const context = {}
    const errorContributor = sinon.stub().returns(errorStore)
    const finishContributor = sinon.stub().returns(callbackStore)
    const errorHandler = sinon.spy()
    const finishHandler = sinon.spy()
    let errorActiveStore
    let finishActiveStore

    sourceRegistry.registerContributor('db.query', 'product', {
      error: errorContributor,
      finish: finishContributor,
    })
    channels.start.bindStore(legacyStorage, () => processorStore)
    bindings.push(channels.start)
    subscribe(channels.error, event => {
      errorActiveStore = legacyStorage.getStore()
      errorHandler(event)
    })
    subscribe(channels.finish, event => {
      finishActiveStore = legacyStorage.getStore()
      finishHandler(event)
    })

    const bridge = new SemanticLifecycleBridge({
      operation: 'db.query',
      channels,
      normalize: identity,
      sourceRegistry,
    })

    legacyStorage.run(parentStore, () => bridge.start(context))
    context.error = new Error('query failed')

    bridge.error(context)
    bridge.error(context)
    const firstFinishStore = bridge.finish(context)
    const secondFinishStore = bridge.finish(context)
    bridge.error(context)

    sinon.assert.calledOnceWithExactly(errorContributor, context, parentStore)
    sinon.assert.calledOnceWithExactly(finishContributor, context, errorStore)
    sinon.assert.calledOnceWithExactly(errorHandler, context)
    sinon.assert.calledOnceWithExactly(finishHandler, context)
    assert.strictEqual(errorActiveStore, processorStore)
    assert.strictEqual(finishActiveStore, processorStore)
    assert.strictEqual(firstFinishStore, callbackStore)
    assert.strictEqual(secondFinishStore, callbackStore)
  })

  it('supports product contributors without a semantic processor subscriber', () => {
    const sourceRegistry = new EventSourceRegistry()
    const channels = createChannels()
    const parentStore = { parent: true }
    const contributorStore = { contributor: true }
    const callbackStore = { callback: true }
    const context = {}

    sourceRegistry.registerContributor('db.query', 'iast', {
      start: sinon.stub().returns(contributorStore),
      finish: sinon.stub().returns(callbackStore),
    })

    const bridge = new SemanticLifecycleBridge({
      operation: 'db.query',
      channels,
      normalize: identity,
      sourceRegistry,
    })

    let operationStore
    legacyStorage.run(parentStore, () => {
      operationStore = bridge.start(context)
    })

    assert.strictEqual(operationStore, contributorStore)
    assert.strictEqual(bridge.finish(context), callbackStore)
  })

  it('keeps concurrent source contexts isolated', () => {
    const sourceRegistry = new EventSourceRegistry()
    const channels = createChannels()
    const finished = []
    const first = { id: 1 }
    const second = { id: 2 }

    subscribe(channels.finish, event => finished.push(event.id))

    const bridge = new SemanticLifecycleBridge({
      operation: 'db.query',
      channels,
      normalize: identity,
      sourceRegistry,
    })

    bridge.start(first)
    bridge.start(second)
    bridge.finish(second)
    bridge.finish(first)

    assert.deepStrictEqual(finished, [2, 1])
  })

  it('validates the bridge contract', () => {
    const channels = createChannels()

    assert.throws(
      () => new SemanticLifecycleBridge({ operation: '', channels, normalize: identity }),
      /requires an operation/
    )
    assert.throws(
      () => new SemanticLifecycleBridge({ operation: 'db.query', channels: {}, normalize: identity }),
      /requires start, error, and finish channels/
    )
    assert.throws(
      () => new SemanticLifecycleBridge({ operation: 'db.query', channels, normalize: undefined }),
      /requires a normalizer/
    )

    const bridge = new SemanticLifecycleBridge({
      operation: 'db.query',
      channels,
      normalize: () => undefined,
      sourceRegistry: new EventSourceRegistry(),
    })

    assert.throws(() => bridge.start(undefined), /requires an object context/)
    assert.throws(() => bridge.start({}), /normalizer must return an event object/)
  })
})

function createChannels () {
  return createLifecycleChannels(`tracing:datadog:test:operation:${channelId++}`, [
    'start',
    'error',
    'finish',
  ])
}

function subscribe (channel, handler) {
  channel.subscribe(handler)
  subscriptions.push([channel, handler])
}

function identity (value) {
  return value
}
