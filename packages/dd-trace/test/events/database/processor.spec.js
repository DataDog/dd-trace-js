'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { storage } = require('../../../../datadog-core')
const { CLIENT_PORT_KEY } = require('../../../src/constants')
const { DatabaseProcessor } = require('../../../src/events/database')
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

  it('owns no package source subscriptions or bindings', () => {
    const harness = createHarness()

    assert.strictEqual(harness.processor._bindings.length, 0)
    assert.strictEqual(harness.processor._subscriptions.length, 0)
  })

  it('reuses one source consumer when a plugin is recreated for the same tracer', () => {
    const harness = createHarness()

    assert.strictEqual(harness.processor.createSourceConsumer(harness.runtime), harness.consumer)
  })

  it('processes a normalized query through the fixed lifecycle adapter', () => {
    const harness = createHarness()
    const parentStore = { parent: true }
    const event = createEvent(parentStore)

    const activeStore = legacyStorage.run(parentStore, () => harness.consumer.start(event))
    harness.consumer.complete(event)

    assert.strictEqual(activeStore, event.currentStore)
    assert.strictEqual(activeStore.span, harness.span)
    sinon.assert.calledOnce(harness.span.finish)
  })

  it('builds database telemetry policy from package identity and source facts', () => {
    const harness = createHarness()
    const parentStore = { parent: true }
    const event = createEvent(parentStore)

    assert.strictEqual(harness.consumer.start(event), event.currentStore)

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
    const event = createEvent({ parent: true }, 'mysql')

    harness.consumer.start(event)

    sinon.assert.calledOnceWithExactly(harness.processor.serviceName, {
      dbConfig: event.facts.connection,
      id: 'mysql',
      pluginConfig: harness.runtime.config,
      system: 'mysql',
    })
    assert.strictEqual(harness.processor.startSpan.firstCall.args[0], 'mysql.query')
    assert.strictEqual(harness.processor.startSpan.firstCall.args[1].type, 'sql')
    assert.strictEqual(harness.processor.startSpan.firstCall.args[1].service, service)
    assert.strictEqual(harness.processor.startSpan.firstCall.args[1].meta['db.type'], 'mysql')
    assert.strictEqual(harness.processor.startSpan.firstCall.args[1].meta['db.system'], undefined)
  })

  it('processes pool acquisition through the shared database processor', () => {
    const adapter = createAdapter({
      identity: {
        integration: 'mariadb',
        system: 'mariadb',
      },
      lifecycle: 'pool.acquire',
    })
    const harness = createHarness(adapter, 'mariadb', 'db.pool.acquire')
    const service = { name: 'mariadb-service', source: 'mariadb' }
    sinon.stub(harness.processor, 'serviceName').returns(service)
    const parentStore = { parent: true }
    const event = createEvent(parentStore, 'mariadb', {
      connection: {
        database: 'database',
        host: 'localhost',
        port: 3306,
        user: 'user',
      },
    })

    assert.strictEqual(harness.consumer.start(event), event.currentStore)
    event.metadata = { 'mariadb.pool.wait_time': 12.5 }
    harness.consumer.complete(event)

    sinon.assert.calledOnceWithExactly(
      harness.processor.startSpan,
      'mariadb.pool.acquire',
      {
        component: 'mariadb',
        config: harness.runtime.config,
        integrationName: 'mariadb',
        kind: 'client',
        meta: {
          component: 'mariadb',
          'db.type': 'mariadb',
          'db.user': 'user',
          'db.name': 'database',
          'out.host': 'localhost',
          [CLIENT_PORT_KEY]: 3306,
        },
        resource: 'mariadb.pool.acquire',
        service,
        type: 'sql',
      },
      event
    )
    sinon.assert.calledOnceWithExactly(harness.span.addTags, event.metadata)
    sinon.assert.calledOnce(harness.span.finish)
  })

  it('applies completion metadata and releases state exactly once', () => {
    const harness = createHarness()
    const event = createEvent({ parent: true })
    const metadata = {
      'db.response.status_code': '201',
      'cosmosdb.response.sub_status_code': 1000,
    }
    event.metadata = metadata

    harness.consumer.start(event)
    harness.consumer.complete(event)
    harness.consumer.complete(event)

    sinon.assert.calledOnceWithExactly(harness.span.addTags, metadata)
    sinon.assert.calledOnce(harness.span.finish)
  })

  it('applies error metadata and records an application error', () => {
    const harness = createHarness()
    const error = new Error('query failed')
    const metadata = { 'db.response.status_code': '409' }
    const event = { ...createEvent({ parent: true }), error, metadata }
    sinon.stub(harness.processor, 'addError')

    harness.consumer.start(event)
    harness.consumer.fail(event)
    harness.consumer.fail(event)

    sinon.assert.calledOnceWithExactly(harness.span.addTags, metadata)
    sinon.assert.calledOnceWithExactly(harness.processor.addError, error, harness.span)
    sinon.assert.calledOnce(harness.span.finish)
  })

  it('returns parent and no-op stores for source skip decisions', () => {
    const harness = createHarness()
    const parentStore = { parent: true }
    const parentEvent = createEvent(parentStore, 'azure-cosmos', { skip: 'parent' })
    const noopEvent = createEvent(parentStore, 'azure-cosmos', { skip: 'noop' })

    assert.strictEqual(harness.consumer.start(parentEvent), parentStore)
    assert.deepStrictEqual(harness.consumer.start(noopEvent), { noop: true })
    sinon.assert.notCalled(harness.processor.startSpan)
  })

  it('returns the parent store for a disabled source', () => {
    const harness = createHarness()
    harness.registry.configureSource('db.query', 'azure-cosmos', false)
    const parentStore = { parent: true }
    const event = createEvent(parentStore)

    assert.strictEqual(harness.consumer.start(event), parentStore)
    sinon.assert.notCalled(harness.processor.startSpan)
  })

  it('isolates trace start failures', () => {
    const harness = createHarness()
    const error = new Error('span start failed')
    harness.processor.startSpan.throws(error)
    const logError = sinon.stub(log, 'error')
    const parentStore = { parent: true }

    assert.strictEqual(harness.consumer.start(createEvent(parentStore)), parentStore)
    sinon.assert.calledOnceWithExactly(
      logError,
      'Database source "%s" failed to start tracing: %s',
      'azure-cosmos',
      error.message
    )
  })

  it('isolates adapter completion failures after finishing the span', () => {
    const harness = createHarness()
    const error = new Error('tagging failed')
    harness.span.addTags.throws(error)
    const logError = sinon.stub(log, 'error')
    const event = createEvent({ parent: true })
    event.metadata = { status: 200 }

    harness.consumer.start(event)
    harness.consumer.complete(event)

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

    harness.consumer.start(event)
    harness.consumer.fail(event)

    sinon.assert.calledOnce(harness.span.finish)
    sinon.assert.calledOnceWithExactly(
      logError,
      'Database query adapter failed during error: %s',
      error.message
    )
  })

  function createHarness (adapter = createAdapter(), source = 'azure-cosmos', operation = 'db.query') {
    const tracer = {
      _env: 'test',
      _nomenclature: {
        opName: () => `${source}.query`,
      },
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
    const processor = registry.registerProcessor({ domain: 'database', operation, Processor: DatabaseProcessor })
    const runtime = registry.registerSource({ operation, source, adapter })
    const span = createSpan()
    sinon.stub(processor, 'startSpan').callsFake((name, options, event) => {
      event.parentStore = legacyStorage.getStore()
      event.currentStore = { ...event.parentStore, span }
      return span
    })
    registry.configureSource(operation, source, { enabled: true })
    const consumer = processor.createSourceConsumer(runtime)

    return { adapter, consumer, processor, registry, runtime, span }
  }
})

function createAdapter (overrides = {}) {
  return {
    identity: {
      integration: 'azure-cosmos',
      schema: false,
      system: 'cosmosdb',
    },
    ...overrides,
  }
}

function createEvent (parentStore, integration = 'azure-cosmos', facts = createFacts()) {
  return {
    facts,
    parentStore,
    source: { integration },
  }
}

function createFacts () {
  return {
    connection: {
      database: 'database',
      host: 'localhost',
      port: 8081,
      user: 'user',
    },
    resource: 'read /dbs/database/colls/container/docs/?',
    tags: { 'cosmosdb.container': 'container' },
  }
}

function createSpan () {
  return {
    addTags: sinon.stub(),
    finish: sinon.stub(),
  }
}
