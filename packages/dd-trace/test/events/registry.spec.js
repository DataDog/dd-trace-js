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

  it('rejects a second processor owner for the same operation', () => {
    class OtherProcessor {}

    const registry = new EventDomainRegistry({}, {})
    registry.registerProcessor({ operation: 'db.query', Processor: TestProcessor })

    assert.throws(
      () => registry.registerProcessor({ operation: 'db.query', Processor: OtherProcessor }),
      /Processor already registered for operation "db\.query"/
    )
  })

  it('keeps source configuration isolated while sharing processor enablement', () => {
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

    const updatedMysqlConfig = { enabled: true, service: 'updated-mysql-service' }
    registry.configureSource('db.query', 'mysql', updatedMysqlConfig)

    sinon.assert.calledOnceWithExactly(processor.configure, { enabled: true })
    assert.strictEqual(registry.getSource('db.query', 'mysql'), mysqlRuntime)
    assert.strictEqual(registry.getSource('db.query', 'mariadb'), mariadbRuntime)
    assert.strictEqual(mysqlRuntime.adapter, mysqlAdapter)
    assert.strictEqual(mysqlRuntime.config, updatedMysqlConfig)
    assert.strictEqual(mariadbRuntime.adapter, mariadbAdapter)
    assert.strictEqual(mariadbRuntime.config, mariadbConfig)
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

  it('rejects duplicate source registrations', () => {
    const registry = new EventDomainRegistry({}, {})
    registry.registerProcessor({ operation: 'db.query', Processor: TestProcessor })
    registry.registerSource({ operation: 'db.query', source: 'mysql', adapter: {} })

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
