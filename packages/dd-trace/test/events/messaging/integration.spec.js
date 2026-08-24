'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const dc = require('dc-polyfill')
const sinon = require('sinon')

const { createMessagingIntegration } = require('../../../src/events/messaging')
const { getEventSourceRegistry } = require('../../../src/events/source-registry')

describe('createMessagingIntegration', () => {
  const plugins = []

  afterEach(() => {
    for (const plugin of plugins) plugin.configure(false)
    plugins.length = 0
    sinon.restore()
  })

  it('shares one physical Orchestrion bridge across tracer consumers', async () => {
    const id = 'test-messaging-shared-source'
    const start = sinon.stub().returns(createFacts())
    const Integration = createIntegration(id, 'produce', { start })
    const firstSpan = createSpan()
    const secondSpan = createSpan()
    const first = new Integration(createTracer('first', firstSpan), createTracerConfig())
    const second = new Integration(createTracer('second', secondSpan), createTracerConfig())
    plugins.push(first, second)

    first.configure({ enabled: true })
    second.configure({ enabled: true })

    const runtime = getEventSourceRegistry().getSource('messaging.produce', id)
    assert.strictEqual(runtime.consumers.size, 2)
    assert.strictEqual(runtime.instance._bindings.length, 1)
    assert.strictEqual(runtime.instance._subscriptions.length, 3)

    const context = { arguments: [] }
    const channel = dc.tracingChannel(`orchestrion:test:${id}:produce`)
    assert.strictEqual(await channel.tracePromise(() => Promise.resolve('result'), context), 'result')

    sinon.assert.calledOnceWithExactly(start, context)
    sinon.assert.calledOnce(firstSpan.finish)
    sinon.assert.calledOnce(secondSpan.finish)
  })

  it('writes processor-owned propagation through the package source adapter', async () => {
    const id = 'test-messaging-source-update'
    const facts = createFacts()
    const target = {
      start: sinon.stub().returns(facts),
      updateSource: sinon.stub(),
    }
    const Integration = createIntegration(id, 'produce', target)
    const span = createSpan()
    const tracer = createTracer('update', span)
    tracer.inject.callsFake((activeSpan, format, carrier) => {
      carrier.trace = 'injected'
    })
    const plugin = new Integration(tracer, createTracerConfig())
    plugins.push(plugin)
    plugin.configure({ enabled: true })

    const context = { arguments: [] }
    const channel = dc.tracingChannel(`orchestrion:test:${id}:produce`)
    await channel.tracePromise(() => Promise.resolve(), context)

    const updates = target.updateSource.firstCall.args[2]
    sinon.assert.calledOnceWithExactly(target.updateSource, context, facts, updates)
    assert.deepStrictEqual(updates, {
      carriers: [{ carrier: { trace: 'injected' }, index: 0 }],
    })
  })

  it('maps configuration once before freezing the per-source runtime', () => {
    const id = 'test-messaging-configure-source'
    const configure = sinon.stub().callsFake(config => ({ ...config, mapped: true }))
    const Integration = createIntegration(id, 'produce', { start: () => createFacts() }, configure)
    const plugin = new Integration(createTracer('config', createSpan()), createTracerConfig())
    plugins.push(plugin)

    plugin.configure({ enabled: true, service: 'queue-service' })

    const runtime = getEventSourceRegistry().getSource('messaging.produce', id)
    const consumer = runtime.primaryConsumer
    assert.strictEqual(runtime.consumers.has(consumer), true)
    sinon.assert.calledOnceWithExactly(configure, { enabled: true, service: 'queue-service' })
  })

  it('validates the fixed messaging lifecycle contract', () => {
    assert.throws(() => createMessagingIntegration(), /requires a non-empty id/)
    assert.throws(
      () => createMessagingIntegration({ id: 'invalid', operations: [] }),
      /requires messaging operations/
    )
    assert.throws(
      () => createMessagingIntegration({
        id: 'invalid-adapter',
        operations: [{ adapter: 'query', operation: 'db.query', source: { targets: [] } }],
      }),
      /invalid lifecycle adapter/
    )
    assert.throws(
      () => createMessagingIntegration({
        id: 'invalid-target',
        operations: [{
          adapter: 'produce',
          operation: 'messaging.produce',
          source: { targets: [{ lifecycle: 'async', module: 'test', name: 'add' }] },
        }],
      }),
      /invalid produce target/
    )
  })
})

/**
 * Create a synthetic messaging integration with one Orchestrion target.
 *
 * @param {string} id Integration identifier.
 * @param {'produce' | 'consume'} lifecycle Messaging lifecycle adapter.
 * @param {object} target Package source target methods.
 * @param {(config: object) => object} [configure] Configuration mapper.
 * @returns {Function} Messaging integration class.
 */
function createIntegration (id, lifecycle, target, configure) {
  const operation = `messaging.${lifecycle}`
  return createMessagingIntegration({
    configure,
    id,
    operations: [{
      adapter: lifecycle,
      operation,
      source: {
        targets: [{
          lifecycle: 'async',
          module: 'test',
          name: `${id}:${lifecycle}`,
          ...target,
        }],
      },
    }],
  })
}

/**
 * Create normalized producer facts.
 *
 * @returns {object} Messaging facts.
 */
function createFacts () {
  return {
    action: 'add',
    destination: 'jobs',
    messages: [{ body: { id: 1 }, filter: { name: 'job' }, index: 0 }],
  }
}

/**
 * Create a tracer test double.
 *
 * @param {string} service Tracer service name.
 * @param {object} span Span returned by startSpan.
 * @returns {object} Stubbed tracer.
 */
function createTracer (service, span) {
  return {
    _nomenclature: {
      serviceName: (type, kind, id) => ({ name: `${service}-${id}`, source: id }),
    },
    _service: service,
    decodeDataStreamsContext: sinon.stub(),
    extract: sinon.stub(),
    inject: sinon.stub(),
    setCheckpoint: sinon.stub(),
    startSpan: sinon.stub().returns(span),
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
    context: sinon.stub().returns({ getTag: sinon.stub(), getTags: sinon.stub().returns({}) }),
    finish: sinon.stub(),
    setTag: sinon.stub(),
  }
}
