'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const { storage } = require('../../../../datadog-core')
const databaseChannels = require('../../../src/events/database/channels')
const DatabaseQueryProcessor = require('../../../src/events/database/query-processor')
const { EventDomainRegistry } = require('../../../src/events/registry')

const legacyStorage = storage('legacy')

describe('DatabaseQueryProcessor', () => {
  it('owns only the shared database query phases it processes', () => {
    const processor = new DatabaseQueryProcessor({}, {}, {})

    assert.strictEqual(processor._subscriptions.length, 2)
    assert.strictEqual(processor._bindings.length, 1)
  })

  it('resolves configuration from each operation source', () => {
    const mysqlConfig = { service: 'mysql-service' }
    const mariadbConfig = { service: 'mariadb-service' }
    const registry = {
      getSource: sinon.stub(),
    }
    registry.getSource.withArgs('db.query', 'mysql').returns({ config: mysqlConfig })
    registry.getSource.withArgs('db.query', 'mariadb').returns({ config: mariadbConfig })

    const processor = new DatabaseQueryProcessor({}, {}, registry)
    const span = {}
    processor.serviceName = sinon.stub().returns({ name: 'database-service' })
    processor.operationName = sinon.stub().returns('database.query')
    processor.startSpan = sinon.stub().callsFake((name, options, event) => {
      event.parentStore = { parent: true }
      event.currentStore = { span }
      return span
    })
    processor.injectDbmQuery = sinon.stub().callsFake((span, statement) => statement)

    processor.bindStart(createEvent('mysql'))
    processor.bindStart(createEvent('mariadb'))

    assert.strictEqual(processor.serviceName.firstCall.args[0].pluginConfig, mysqlConfig)
    assert.strictEqual(processor.serviceName.secondCall.args[0].pluginConfig, mariadbConfig)
    assert.strictEqual(processor.startSpan.firstCall.args[1].config, mysqlConfig)
    assert.strictEqual(processor.startSpan.secondCall.args[1].config, mariadbConfig)
    assert.strictEqual(processor.injectDbmQuery.firstCall.args[4], mysqlConfig)
    assert.strictEqual(processor.injectDbmQuery.secondCall.args[4], mariadbConfig)
  })

  it('does not create a span for a disabled or unknown source', () => {
    const parentStore = { parent: true }
    const registry = { getSource: sinon.stub().returns(undefined) }
    const processor = new DatabaseQueryProcessor({}, {}, registry)
    const event = {
      ...createEvent('mysql'),
      parentStore,
    }
    processor.startSpan = sinon.stub()

    assert.strictEqual(processor.bindStart(event), parentStore)
    sinon.assert.notCalled(processor.startSpan)
  })

  it('makes an accepted semantic lifecycle observable inside a noop source context', () => {
    const registry = {
      getSource: sinon.stub().returns({
        config: { dbmPropagationMode: 'disabled' },
      }),
    }
    const processor = new DatabaseQueryProcessor({}, {}, registry)
    const event = createEvent('mariadb')
    const span = {}

    processor.serviceName = sinon.stub().returns({ name: 'mariadb-service' })
    processor.operationName = sinon.stub().returns('mariadb.query')
    processor.startSpan = sinon.stub().callsFake((name, options, event) => {
      event.currentStore = { noop: true, span }
      return span
    })
    processor.injectDbmQuery = sinon.stub().callsFake((span, statement) => statement)

    const store = processor.bindStart(event)

    assert.deepStrictEqual(store, { span })
    assert.deepStrictEqual(event.currentStore, { span })
  })

  it('processes concurrent package sources through one semantic store binding', () => {
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
    }
    const registry = new EventDomainRegistry(tracer, tracerConfig)
    const processor = registry.registerProcessor({
      operation: DatabaseQueryProcessor.eventOperation,
      Processor: DatabaseQueryProcessor,
    })
    const mysqlConfig = { enabled: true, service: 'mysql-service', dbmPropagationMode: 'disabled' }
    const mariadbConfig = { enabled: true, service: 'mariadb-service', dbmPropagationMode: 'disabled' }

    registry.registerSource({ operation: 'db.query', source: 'mysql', adapter: {} })
    registry.registerSource({ operation: 'db.query', source: 'mariadb', adapter: {} })
    processor.serviceName = sinon.stub().callsFake(({ pluginConfig }) => ({ name: pluginConfig.service }))
    processor.operationName = sinon.stub().callsFake(({ id }) => `${id}.query`)
    processor.startSpan = sinon.stub().callsFake((name, options, event) => {
      const span = { name, service: options.service.name }
      event.parentStore = legacyStorage.getStore()
      event.currentStore = { ...event.parentStore, span }
      return span
    })
    processor.injectDbmQuery = sinon.stub().callsFake((span, statement) => statement)

    registry.configureSource('db.query', 'mysql', mysqlConfig)
    registry.configureSource('db.query', 'mariadb', mariadbConfig)

    try {
      const mysqlEvent = createEvent('mysql')
      const mariadbEvent = createEvent('mariadb')

      databaseChannels.queryStart.runStores(mysqlEvent, () => {})
      databaseChannels.queryStart.runStores(mariadbEvent, () => {})

      assert.strictEqual(processor._bindings.length, 1)
      assert.strictEqual(mysqlEvent.currentStore.span.name, 'mysql.query')
      assert.strictEqual(mysqlEvent.currentStore.span.service, 'mysql-service')
      assert.strictEqual(mariadbEvent.currentStore.span.name, 'mariadb.query')
      assert.strictEqual(mariadbEvent.currentStore.span.service, 'mariadb-service')

      registry.configureSource('db.query', 'mysql', false)
      const remainingMariadbEvent = createEvent('mariadb')
      databaseChannels.queryStart.runStores(remainingMariadbEvent, () => {})
      assert.strictEqual(remainingMariadbEvent.currentStore.span.service, 'mariadb-service')
    } finally {
      registry.configureSource('db.query', 'mariadb', false)
    }
  })
})

/**
 * @param {string} integration Database integration identifier.
 * @returns {object} Normalized database query event.
 */
function createEvent (integration) {
  return {
    source: {
      integration,
      system: integration,
    },
    data: {
      statement: 'SELECT 1',
      connection: {
        database: 'database',
        host: 'localhost',
        port: 3306,
        user: 'user',
      },
    },
  }
}
