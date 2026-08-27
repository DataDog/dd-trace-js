'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const {
  EventDomainRegistry,
  getEventDomainRegistry,
} = require('../../src/events/registry')

describe('EventDomainRegistry', () => {
  class TestProcessor {
    constructor (tracer, tracerConfig, registry) {
      this.tracer = tracer
      this.tracerConfig = tracerConfig
      this.registry = registry
      this.configure = sinon.stub()
    }
  }

  it('owns one processor instance per semantic operation', () => {
    const tracer = {}
    const tracerConfig = {}
    const registry = new EventDomainRegistry(tracer, tracerConfig)

    const first = registry.registerProcessor({ operation: 'db.query', Processor: TestProcessor })
    const second = registry.registerProcessor({ operation: 'db.query', Processor: TestProcessor })

    assert.strictEqual(first, second)
    assert.strictEqual(first.tracer, tracer)
    assert.strictEqual(first.tracerConfig, tracerConfig)
    assert.strictEqual(first.registry, registry)
  })

  it('shares one processor across semantic operations in the same domain', () => {
    const registry = new EventDomainRegistry({}, {})

    const query = registry.registerProcessor({
      domain: 'database',
      operation: 'db.query',
      Processor: TestProcessor,
    })
    const acquire = registry.registerProcessor({
      domain: 'database',
      operation: 'db.pool.acquire',
      Processor: TestProcessor,
    })

    assert.strictEqual(query, acquire)
  })

  it('rejects conflicting operation and domain ownership', () => {
    class OtherProcessor {}

    const registry = new EventDomainRegistry({}, {})
    registry.registerProcessor({ domain: 'database', operation: 'db.query', Processor: TestProcessor })

    assert.throws(
      () => registry.registerProcessor({ domain: 'messaging', operation: 'db.query', Processor: TestProcessor }),
      /Processor already registered for operation "db\.query"/
    )
    assert.throws(
      () => registry.registerProcessor({ domain: 'database', operation: 'db.pool.acquire', Processor: OtherProcessor }),
      /Processor already registered for domain "database"/
    )
  })

  it('isolates source keys by operation while sharing domain enablement', () => {
    const registry = new EventDomainRegistry({}, {})
    const processor = registry.registerProcessor({
      domain: 'database',
      operation: 'db.query',
      Processor: TestProcessor,
    })
    registry.registerProcessor({
      domain: 'database',
      operation: 'db.pool.acquire',
      Processor: TestProcessor,
    })
    const query = registry.registerSource({ operation: 'db.query', source: 'mariadb', adapter: {} })
    const acquire = registry.registerSource({ operation: 'db.pool.acquire', source: 'mariadb', adapter: {} })

    registry.configureSource('db.query', 'mariadb', { enabled: true })
    registry.configureSource('db.pool.acquire', 'mariadb', { enabled: true })
    registry.configureSource('db.query', 'mariadb', { enabled: false })

    assert.notStrictEqual(query, acquire)
    assert.strictEqual(registry.getSource('db.query', 'mariadb'), undefined)
    assert.strictEqual(registry.getSource('db.pool.acquire', 'mariadb'), acquire)
    sinon.assert.calledOnceWithExactly(processor.configure, { enabled: true })

    registry.configureSource('db.pool.acquire', 'mariadb', { enabled: false })

    sinon.assert.calledTwice(processor.configure)
    sinon.assert.calledWithExactly(processor.configure.secondCall, { enabled: false })
  })

  it('rejects a second processor owner for the same operation', () => {
    class OtherProcessor {}

    const registry = new EventDomainRegistry({}, {})
    registry.registerProcessor({ operation: 'db.query', Processor: TestProcessor })

    assert.throws(
      () => registry.registerProcessor({ operation: 'db.query', Processor: OtherProcessor }),
      /Processor already registered for operation "db\.query"/
    )
  })

  it('keeps immutable source configuration isolated while sharing processor enablement', () => {
    const registry = new EventDomainRegistry({}, {})
    const processor = registry.registerProcessor({ operation: 'db.query', Processor: TestProcessor })
    const mysqlAdapter = {}
    const mariadbAdapter = {}
    const mysqlRuntime = registry.registerSource({
      operation: 'db.query',
      source: 'mysql',
      adapter: mysqlAdapter,
    })
    const mariadbRuntime = registry.registerSource({
      operation: 'db.query',
      source: 'mariadb',
      adapter: mariadbAdapter,
    })
    const mysqlConfig = { enabled: true, service: 'mysql-service' }
    const mariadbConfig = { enabled: true, service: 'mariadb-service' }

    registry.configureSource('db.query', 'mysql', mysqlConfig)
    registry.configureSource('db.query', 'mariadb', mariadbConfig)
    mysqlConfig.service = 'mutated-outside-registry'
    assert.strictEqual(mysqlRuntime.config.service, 'mysql-service')

    const updatedMysqlConfig = { enabled: true, service: 'updated-mysql-service' }
    registry.configureSource('db.query', 'mysql', updatedMysqlConfig)

    sinon.assert.calledOnceWithExactly(processor.configure, { enabled: true })
    assert.strictEqual(registry.getSource('db.query', 'mysql'), mysqlRuntime)
    assert.strictEqual(registry.getSource('db.query', 'mariadb'), mariadbRuntime)
    assert.strictEqual(mysqlRuntime.adapter, mysqlAdapter)
    assert.deepStrictEqual(mysqlRuntime.config, updatedMysqlConfig)
    assert.notStrictEqual(mysqlRuntime.config, updatedMysqlConfig)
    assert.strictEqual(Object.isFrozen(mysqlRuntime.config), true)
    assert.strictEqual(mariadbRuntime.adapter, mariadbAdapter)
    assert.deepStrictEqual(mariadbRuntime.config, mariadbConfig)
    assert.notStrictEqual(mariadbRuntime.config, mariadbConfig)
    assert.strictEqual(Object.isFrozen(mariadbRuntime.config), true)
  })

  it('keeps the shared processor enabled until the final source is disabled', () => {
    const registry = new EventDomainRegistry({}, {})
    const processor = registry.registerProcessor({ operation: 'db.query', Processor: TestProcessor })
    registry.registerSource({ operation: 'db.query', source: 'mysql', adapter: {} })
    registry.registerSource({ operation: 'db.query', source: 'mariadb', adapter: {} })

    registry.configureSource('db.query', 'mysql', { enabled: true })
    registry.configureSource('db.query', 'mariadb', { enabled: true })
    registry.configureSource('db.query', 'mysql', { enabled: false })

    sinon.assert.calledOnce(processor.configure)
    assert.strictEqual(registry.getSource('db.query', 'mysql'), undefined)
    assert.notStrictEqual(registry.getSource('db.query', 'mariadb'), undefined)

    registry.configureSource('db.query', 'mariadb', { enabled: false })

    sinon.assert.calledTwice(processor.configure)
    sinon.assert.calledWithExactly(processor.configure.secondCall, { enabled: false })

    registry.configureSource('db.query', 'mariadb', { enabled: true })

    sinon.assert.calledThrice(processor.configure)
    sinon.assert.calledWithExactly(processor.configure.thirdCall, { enabled: true })
  })

  it('normalizes boolean source configuration', () => {
    const registry = new EventDomainRegistry({}, {})
    registry.registerProcessor({ operation: 'db.query', Processor: TestProcessor })
    const runtime = registry.registerSource({ operation: 'db.query', source: 'mysql', adapter: {} })

    registry.configureSource('db.query', 'mysql', true)

    assert.deepStrictEqual(runtime.config, { enabled: true })
    assert.strictEqual(Object.isFrozen(runtime.config), true)
  })

  it('reuses an identical source registration and rejects a different adapter', () => {
    const registry = new EventDomainRegistry({}, {})
    registry.registerProcessor({ operation: 'db.query', Processor: TestProcessor })
    const adapter = {}
    const runtime = registry.registerSource({ operation: 'db.query', source: 'mysql', adapter })

    assert.strictEqual(
      registry.registerSource({ operation: 'db.query', source: 'mysql', adapter }),
      runtime
    )

    assert.throws(
      () => registry.registerSource({ operation: 'db.query', source: 'mysql', adapter: {} }),
      /Source "mysql" already registered for operation "db\.query"/
    )
  })

  it('rejects sources and configuration for unknown registrations', () => {
    const registry = new EventDomainRegistry({}, {})

    assert.throws(
      () => registry.registerSource({ operation: 'db.query', source: 'mysql', adapter: {} }),
      /No processor registered for operation "db\.query"/
    )

    registry.registerProcessor({ operation: 'db.query', Processor: TestProcessor })

    assert.throws(
      () => registry.configureSource('db.query', 'mysql', { enabled: true }),
      /No source "mysql" registered for operation "db\.query"/
    )
  })

  it('disables active processors when destroyed', () => {
    const registry = new EventDomainRegistry({}, {})
    const processor = registry.registerProcessor({ operation: 'db.query', Processor: TestProcessor })
    registry.registerSource({ operation: 'db.query', source: 'mysql', adapter: {} })
    registry.configureSource('db.query', 'mysql', { enabled: true })

    registry.destroy()

    sinon.assert.calledTwice(processor.configure)
    sinon.assert.calledWithExactly(processor.configure.secondCall, { enabled: false })
    assert.strictEqual(registry.getSource('db.query', 'mysql'), undefined)
  })

  it('uses a different registry for each tracer', () => {
    const tracerConfig = {}
    const firstTracer = {}
    const secondTracer = {}

    const first = getEventDomainRegistry(firstTracer, tracerConfig)

    assert.strictEqual(getEventDomainRegistry(firstTracer, tracerConfig), first)
    assert.notStrictEqual(getEventDomainRegistry(secondTracer, tracerConfig), first)
  })
})
