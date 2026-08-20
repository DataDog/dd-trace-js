'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { storage } = require('../../../../datadog-core')
const { CLIENT_PORT_KEY } = require('../../../src/constants')
const {
  channels: { queryError, queryFinish, queryStart },
  DatabaseProcessor,
} = require('../../../src/events/database')
const { EventDomainRegistry } = require('../../../src/events/registry')
const log = require('../../../src/log')

const legacyStorage = storage('legacy')

describe('DatabaseProcessor', () => {
  let registry

  beforeEach(() => {
    registry = undefined
  })

  afterEach(() => {
    registry?.destroy()
    sinon.restore()
  })

  it('owns only the fixed database query lifecycle phases', () => {
    const harness = createHarness()

    assert.strictEqual(harness.processor._bindings.length, 1)
    assert.strictEqual(harness.processor._bindings[0]._channel, queryStart)
    assert.deepStrictEqual(
      harness.processor._subscriptions.map(subscription => subscription._channel),
      [queryError, queryFinish]
    )
  })

  it('processes a query through the shared semantic lifecycle channels', () => {
    const harness = createHarness()
    const parentStore = { parent: true }
    const event = createEvent(parentStore)

    const activeStore = legacyStorage.run(parentStore, () => {
      return queryStart.runStores(event, () => legacyStorage.getStore())
    })
    queryFinish.publish(event)

    assert.strictEqual(activeStore, event.currentStore)
    assert.strictEqual(activeStore.span, harness.span)
    sinon.assert.calledOnce(harness.span.finish)
  })

  it('builds database telemetry policy from package identity and source facts', () => {
    const harness = createHarness()
    const parentStore = { parent: true }
    const event = createEvent(parentStore)

    assert.strictEqual(harness.processor.bindStart(event), event.currentStore)

    sinon.assert.calledOnceWithExactly(
      harness.processor.startSpan,
      'cosmosdb.query',
      {
        component: 'azure_cosmos',
        config: harness.runtime.config,
        integrationName: 'azure-cosmos',
        kind: 'client',
        meta: {
          component: 'azure_cosmos',
          'db.system': 'cosmosdb',
          'db.user': 'user',
          'db.name': 'database',
          'out.host': 'localhost',
          [CLIENT_PORT_KEY]: 8081,
          'cosmosdb.container': 'container',
        },
        resource: 'read /dbs/database/colls/container/docs/?',
        service: { name: 'test-azure-cosmos', source: 'azure-cosmos' },
        type: 'cosmosdb',
      },
      event
    )
  })

  it('uses schema naming and SQL policy for relational sources', () => {
    const adapter = createAdapter({
      identity: {
        integration: 'mysql',
        schema: 'mysql',
        system: 'mysql',
      },
    })
    const harness = createHarness(adapter, 'mysql')
    const service = { name: 'mysql-service', source: 'mysql' }
    sinon.stub(harness.processor, 'serviceName').returns(service)
    sinon.stub(harness.processor, 'operationName').returns('mysql.query')
    const event = createEvent({ parent: true }, 'mysql')

    harness.processor.bindStart(event)

    sinon.assert.calledOnceWithExactly(harness.processor.serviceName, {
      dbConfig: adapter.start.firstCall.returnValue.connection,
      id: 'mysql',
      pluginConfig: harness.runtime.config,
      system: 'mysql',
    })
    assert.strictEqual(harness.processor.startSpan.firstCall.args[0], 'mysql.query')
    assert.strictEqual(harness.processor.startSpan.firstCall.args[1].type, 'sql')
    assert.strictEqual(harness.processor.startSpan.firstCall.args[1].service, service)
  })

  it('applies completion metadata and releases state exactly once', () => {
    const harness = createHarness()
    const event = createEvent({ parent: true })
    const metadata = {
      'db.response.status_code': '201',
      'cosmosdb.response.sub_status_code': 1000,
    }
    harness.adapter.complete.returns(metadata)

    harness.processor.bindStart(event)
    harness.processor.complete(event)
    harness.processor.complete(event)

    sinon.assert.calledOnceWithExactly(harness.span.addTags, metadata)
    sinon.assert.calledOnce(harness.span.finish)
    sinon.assert.calledOnceWithExactly(harness.adapter.complete, event)
  })

  it('applies error metadata and records an application error', () => {
    const harness = createHarness()
    const error = new Error('query failed')
    const event = { ...createEvent({ parent: true }), error }
    const metadata = { 'db.response.status_code': '409' }
    harness.adapter.complete.returns(metadata)
    sinon.stub(harness.processor, 'addError')

    harness.processor.bindStart(event)
    harness.processor.fail(event)
    harness.processor.fail(event)

    sinon.assert.calledOnceWithExactly(harness.span.addTags, metadata)
    sinon.assert.calledOnceWithExactly(harness.processor.addError, error, harness.span)
    sinon.assert.calledOnce(harness.span.finish)
  })

  it('returns parent and no-op stores for source skip decisions', () => {
    const adapter = createAdapter()
    const harness = createHarness(adapter)
    const parentStore = { parent: true }
    const parentEvent = createEvent(parentStore)
    const noopEvent = createEvent(parentStore)
    adapter.start.onFirstCall().returns({ skip: 'parent' })
    adapter.start.onSecondCall().returns({ skip: 'noop' })

    assert.strictEqual(harness.processor.bindStart(parentEvent), parentStore)
    assert.deepStrictEqual(harness.processor.bindStart(noopEvent), { noop: true })
    sinon.assert.notCalled(harness.processor.startSpan)
  })

  it('returns the parent store for disabled or unknown sources', () => {
    const harness = createHarness()
    harness.registry.configureSource('db.query', 'azure-cosmos', false)
    const parentStore = { parent: true }
    const event = createEvent(parentStore)

    assert.strictEqual(harness.processor.bindStart(event), parentStore)
    sinon.assert.notCalled(harness.processor.startSpan)
  })

  it('isolates source start failures', () => {
    const adapter = createAdapter()
    const error = new Error('extractor failed')
    adapter.start.throws(error)
    const harness = createHarness(adapter)
    const logError = sinon.stub(log, 'error')
    const parentStore = { parent: true }

    assert.strictEqual(harness.processor.bindStart(createEvent(parentStore)), parentStore)
    sinon.assert.notCalled(harness.processor.startSpan)
    sinon.assert.calledOnceWithExactly(
      logError,
      'Database source "%s" failed during start: %s',
      'azure-cosmos',
      error.message
    )
  })

  it('isolates trace start failures', () => {
    const harness = createHarness()
    const error = new Error('span start failed')
    harness.processor.startSpan.throws(error)
    const logError = sinon.stub(log, 'error')
    const parentStore = { parent: true }

    assert.strictEqual(harness.processor.bindStart(createEvent(parentStore)), parentStore)
    sinon.assert.calledOnceWithExactly(
      logError,
      'Database source "%s" failed to start tracing: %s',
      'azure-cosmos',
      error.message
    )
  })

  it('isolates source update and completion failures while still finishing', () => {
    const adapter = createAdapter()
    const updateError = new Error('update failed')
    const completeError = new Error('completion failed')
    adapter.updateSource = sinon.stub().throws(updateError)
    adapter.complete.throws(completeError)
    const harness = createHarness(adapter)
    const logError = sinon.stub(log, 'error')
    const event = createEvent({ parent: true })

    harness.processor.bindStart(event)
    harness.processor.complete(event)

    sinon.assert.calledTwice(logError)
    sinon.assert.calledWithExactly(
      logError.firstCall,
      'Database source "%s" failed during source update: %s',
      'azure-cosmos',
      updateError.message
    )
    sinon.assert.calledWithExactly(
      logError.secondCall,
      'Database source "%s" failed during completion: %s',
      'azure-cosmos',
      completeError.message
    )
    sinon.assert.calledOnce(harness.span.finish)
  })

  it('isolates adapter completion failures after finishing the span', () => {
    const harness = createHarness()
    const error = new Error('tagging failed')
    harness.span.addTags.throws(error)
    harness.adapter.complete.returns({ status: 200 })
    const logError = sinon.stub(log, 'error')
    const event = createEvent({ parent: true })

    harness.processor.bindStart(event)
    harness.processor.complete(event)

    sinon.assert.calledOnce(harness.span.finish)
    sinon.assert.calledOnceWithExactly(
      logError,
      'Database query adapter failed during completion: %s',
      error.message
    )
  })

  it('isolates adapter error failures after finishing the span', () => {
    const harness = createHarness()
    const error = new Error('error tagging failed')
    sinon.stub(harness.processor, 'addError').throws(error)
    const logError = sinon.stub(log, 'error')
    const event = { ...createEvent({ parent: true }), error: new Error('query failed') }

    harness.processor.bindStart(event)
    harness.processor.fail(event)

    sinon.assert.calledOnce(harness.span.finish)
    sinon.assert.calledOnceWithExactly(
      logError,
      'Database query adapter failed during error: %s',
      error.message
    )
  })

  function createHarness (adapter = createAdapter(), source = 'azure-cosmos') {
    const tracer = {
      _env: 'test',
      _service: 'test',
      _version: '1.0.0',
    }
    const tracerConfig = {
      codeOriginForSpans: {
        enabled: false,
        experimental: { exit_spans: { enabled: false } },
      },
      spanComputePeerService: false,
    }
    registry = new EventDomainRegistry(tracer, tracerConfig)
    const processor = registry.registerProcessor({ operation: 'db.query', Processor: DatabaseProcessor })
    const runtime = registry.registerSource({ operation: 'db.query', source, adapter })
    const span = createSpan()
    sinon.stub(processor, 'startSpan').callsFake((name, options, event) => {
      event.parentStore = legacyStorage.getStore()
      event.currentStore = { ...event.parentStore, span }
      return span
    })
    registry.configureSource('db.query', source, { enabled: true })

    return { adapter, processor, registry, runtime, span }
  }
})

function createAdapter (overrides = {}) {
  return {
    complete: sinon.stub(),
    identity: {
      integration: 'azure-cosmos',
      schema: false,
      system: 'cosmosdb',
    },
    start: sinon.stub().returns({
      connection: {
        database: 'database',
        host: 'localhost',
        port: 8081,
        user: 'user',
      },
      resource: 'read /dbs/database/colls/container/docs/?',
      tags: { 'cosmosdb.container': 'container' },
    }),
    ...overrides,
  }
}

function createEvent (parentStore, integration = 'azure-cosmos') {
  return {
    parentStore,
    source: { integration },
  }
}

function createSpan () {
  return {
    addTags: sinon.stub(),
    finish: sinon.stub(),
  }
}
