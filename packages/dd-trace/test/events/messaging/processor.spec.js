'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { storage } = require('../../../../datadog-core')
const { DsmPathwayCodec } = require('../../../src/datastreams')
const { MessagingProcessor } = require('../../../src/events/messaging')
const { EventDomainRegistry } = require('../../../src/events/registry')
const log = require('../../../src/log')

const legacyStorage = storage('legacy')

describe('MessagingProcessor', () => {
  let registry

  afterEach(() => {
    registry?.destroy()
    sinon.restore()
  })

  it('owns no package source subscriptions or bindings', () => {
    const harness = createHarness()

    assert.strictEqual(harness.processor._bindings.length, 0)
    assert.strictEqual(harness.processor._subscriptions.length, 0)
  })

  it('builds producer telemetry through the fixed produce adapter', () => {
    const harness = createHarness()
    const event = createEvent({ parent: true })

    assert.strictEqual(harness.consumer.start(event), event.currentStore)

    sinon.assert.calledOnceWithExactly(
      harness.processor.startSpan,
      'bullmq.add',
      {
        component: 'bullmq',
        config: harness.runtime.config,
        integrationName: 'bullmq',
        kind: 'producer',
        meta: {
          component: 'bullmq',
          'messaging.system': 'bullmq',
          'messaging.destination.name': 'jobs',
          'messaging.operation': 'publish',
        },
        resource: 'jobs',
        service: { name: 'test-bullmq-producer', source: 'bullmq' },
        type: 'messaging',
      },
      event
    )
  })

  it('injects trace context into normalized producer carriers', () => {
    const harness = createHarness()
    const event = createEvent({ parent: true })

    harness.consumer.start(event)

    assert.strictEqual(event.updates.carriers.length, 1)
    assert.strictEqual(event.updates.carriers[0].index, 0)
    sinon.assert.calledOnceWithExactly(
      harness.tracer.inject,
      harness.span,
      'text_map',
      event.updates.carriers[0].carrier
    )
  })

  it('creates producer data-stream checkpoints for every accepted message', () => {
    const messages = [
      { body: { id: 1 }, filter: { name: 'first' }, index: 0 },
      { body: false, filter: { name: 'second' }, index: 2 },
    ]
    const harness = createHarness(undefined, 'messaging.produce', { dsmEnabled: true, enabled: true })
    const event = createEvent({ parent: true }, { messageCount: 3, messages })
    const pathway = { pathway: true }
    harness.tracer.setCheckpoint.returns(pathway)
    sinon.stub(DsmPathwayCodec, 'encode')

    harness.consumer.start(event)

    assert.strictEqual(harness.tracer.setCheckpoint.callCount, 2)
    sinon.assert.calledWithExactly(
      harness.tracer.setCheckpoint.firstCall,
      ['direction:out', 'topic:jobs', 'type:bullmq'],
      harness.span,
      sinon.match.number
    )
    assert.strictEqual(harness.tracer.setCheckpoint.secondCall.args[2], 0)
    sinon.assert.calledTwice(DsmPathwayCodec.encode)
    assert.deepStrictEqual(event.updates.carriers.map(update => update.index), [0, 2])
  })

  it('applies producer filters before tracing and preserves empty batches', () => {
    const filter = sinon.stub().callsFake(job => job.name === 'accepted')
    const harness = createHarness(undefined, 'messaging.produce', {
      enabled: true,
      producerFilter: filter,
    })
    const rejected = createEvent({ parent: true }, {
      messageCount: 1,
      messages: [{ body: {}, filter: { name: 'rejected' }, index: 0 }],
    })
    const empty = createEvent({ parent: true }, { messageCount: 0, messages: [] })

    assert.deepStrictEqual(harness.consumer.start(rejected), { noop: true })
    assert.strictEqual(harness.consumer.start(empty), empty.currentStore)

    sinon.assert.calledOnceWithExactly(filter, rejected.facts.messages[0].filter)
    sinon.assert.calledOnce(harness.processor.startSpan)
  })

  it('disables filtering for an invocation when a producer filter throws', () => {
    const filterError = new Error('filter failed')
    const harness = createHarness(undefined, 'messaging.produce', {
      enabled: true,
      producerFilter: sinon.stub().throws(filterError),
    })
    const logError = sinon.stub(log, 'error')
    const event = createEvent({ parent: true })

    assert.strictEqual(harness.consumer.start(event), event.currentStore)

    sinon.assert.calledOnceWithExactly(
      logError,
      'bullmq: producerFilter threw, filtering is disabled: %s',
      filterError.message
    )
    sinon.assert.calledOnce(harness.tracer.inject)
  })

  it('extracts consumer context before tracing and establishes its data-stream pathway', () => {
    const harness = createHarness({ lifecycle: 'consume' }, 'messaging.consume', {
      dsmEnabled: true,
      enabled: true,
    })
    const parent = { parent: true }
    const carrier = { trace: '1' }
    harness.tracer.extract.returns(parent)
    const event = createEvent({ caller: true }, {
      action: 'processJob',
      body: { id: 1 },
      carrier,
    })

    harness.consumer.start(event)

    sinon.assert.calledOnceWithExactly(harness.tracer.extract, 'text_map', carrier)
    assert.strictEqual(harness.processor.startSpan.firstCall.args[1].childOf, parent)
    sinon.assert.calledOnceWithExactly(harness.tracer.decodeDataStreamsContext, carrier)
    sinon.assert.calledOnceWithExactly(
      harness.tracer.setCheckpoint,
      ['direction:in', 'topic:jobs', 'type:bullmq'],
      harness.span,
      sinon.match.number
    )
  })

  it('clears inherited data-stream context when a consumed message has no carrier', () => {
    const harness = createHarness({ lifecycle: 'consume' }, 'messaging.consume', {
      dsmEnabled: true,
      enabled: true,
    })
    const event = createEvent({ parent: true }, { action: 'processJob', body: false, carrier: undefined })

    harness.consumer.start(event)

    sinon.assert.calledOnceWithExactly(harness.tracer.decodeDataStreamsContext, undefined)
    assert.strictEqual(harness.tracer.setCheckpoint.firstCall.args[2], 0)
  })

  it('returns the operation store after consumer data-stream context is established', () => {
    const harness = createHarness({ lifecycle: 'consume' }, 'messaging.consume', {
      dsmEnabled: true,
      enabled: true,
    })
    const pathway = { pathway: 'consumer' }
    harness.tracer.decodeDataStreamsContext.callsFake(() => {
      const store = legacyStorage.getStore()
      assert.strictEqual(store.span, harness.span)
      legacyStorage.enterWith({ ...store, dataStreamsContext: pathway })
    })
    const event = createEvent({ parent: true }, { action: 'processJob', carrier: { trace: '1' } })

    assert.strictEqual(harness.consumer.start(event), event.currentStore)
    assert.strictEqual(event.currentStore.span, harness.span)
    assert.strictEqual(event.currentStore.dataStreamsContext, pathway)
  })

  it('finishes successful and failed messaging operations exactly once', () => {
    const harness = createHarness()
    const success = createEvent({ parent: true })
    const failure = createEvent({ parent: true })
    failure.error = new Error('publish failed')

    harness.consumer.start(success)
    harness.consumer.complete(success)
    harness.consumer.complete(success)
    harness.consumer.start(failure)
    harness.consumer.fail(failure)
    harness.consumer.fail(failure)

    assert.strictEqual(harness.span.finish.callCount, 2)
    sinon.assert.calledOnceWithExactly(harness.processor.addError, failure.error, harness.span)
  })

  /**
   * Create one messaging processor harness.
   *
   * @param {object} [adapterOverrides] Source adapter overrides.
   * @param {string} [operation] Semantic operation.
   * @param {object} [config] Source configuration.
   * @returns {object} Processor test harness.
   */
  function createHarness (
    adapterOverrides,
    operation = 'messaging.produce',
    config = { enabled: true }
  ) {
    const span = createSpan()
    const tracer = createTracer()
    const tracerConfig = createTracerConfig()
    registry = new EventDomainRegistry(tracer, tracerConfig)
    const processor = registry.registerProcessor({ domain: 'messaging', operation, Processor: MessagingProcessor })
    const adapter = {
      identity: { integration: 'bullmq', system: 'bullmq' },
      lifecycle: 'produce',
      ...adapterOverrides,
    }
    const runtime = registry.registerSource({ adapter, operation, source: 'bullmq' })
    sinon.stub(processor, 'startSpan').callsFake((name, options, event) => {
      event.parentStore = legacyStorage.getStore()
      event.currentStore = { ...event.parentStore, span }
      return span
    })
    sinon.stub(processor, 'addError')
    registry.configureSource(operation, 'bullmq', config)
    const consumer = processor.createSourceConsumer(runtime)

    return { consumer, processor, registry, runtime, span, tracer }
  }
})

/**
 * Create one normalized messaging event.
 *
 * @param {object} parentStore Parent legacy store.
 * @param {object} [overrides] Fact overrides.
 * @returns {object} Messaging source event.
 */
function createEvent (parentStore, overrides = {}) {
  return {
    facts: {
      action: 'add',
      destination: 'jobs',
      messageCount: undefined,
      messages: [{ body: { id: 1 }, filter: { name: 'job' }, index: 0 }],
      ...overrides,
    },
    parentStore,
    source: { integration: 'bullmq' },
  }
}

/**
 * Create the tracer surface used by a messaging processor.
 *
 * @returns {object} Stubbed tracer.
 */
function createTracer () {
  return {
    _nomenclature: {
      serviceName: (type, kind, id) => ({ name: `test-${id}-${kind}`, source: id }),
    },
    _service: 'test',
    decodeDataStreamsContext: sinon.stub(),
    extract: sinon.stub(),
    inject: sinon.stub(),
    setCheckpoint: sinon.stub(),
  }
}

/**
 * Create global tracer configuration required by TracingPlugin.
 *
 * @returns {object} Tracer configuration.
 */
function createTracerConfig () {
  return {
    codeOriginForSpans: {
      enabled: false,
      experimental: { exit_spans: { enabled: false } },
    },
    spanComputePeerService: false,
  }
}

/**
 * Create one span test double.
 *
 * @returns {object} Stubbed span.
 */
function createSpan () {
  return {
    addTags: sinon.stub(),
    finish: sinon.stub(),
    setTag: sinon.stub(),
  }
}
