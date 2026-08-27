'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const dc = require('dc-polyfill')
const sinon = require('sinon')

const log = require('../../src/log')
const { EventSourceRegistry, getEventSourceRegistry } = require('../../src/events/source-registry')

describe('EventSourceRegistry', () => {
  it('exposes one process-wide registry', () => {
    assert.strictEqual(getEventSourceRegistry(), getEventSourceRegistry())
  })

  it('lazily enables a source until its final consumer releases it', () => {
    const registry = new EventSourceRegistry()
    const bridge = { configure: sinon.stub() }
    const create = sinon.stub().returns(bridge)
    const firstConsumer = {}
    const secondConsumer = {}
    const runtime = registry.registerSource({
      operation: 'db.query',
      source: 'mysql',
      owner: 'datadog-plugin-mysql',
      create,
    })

    sinon.assert.notCalled(create)

    registry.acquireSource('db.query', 'mysql', firstConsumer)
    assert.strictEqual(runtime.primaryConsumer, firstConsumer)
    registry.acquireSource('db.query', 'mysql', secondConsumer)
    assert.strictEqual(runtime.primaryConsumer, firstConsumer)
    registry.releaseSource('db.query', 'mysql', firstConsumer)
    assert.strictEqual(runtime.primaryConsumer, secondConsumer)

    sinon.assert.calledOnceWithExactly(create, runtime)
    sinon.assert.calledOnceWithExactly(bridge.configure, { enabled: true })
    assert.strictEqual(runtime.active, true)

    registry.releaseSource('db.query', 'mysql', secondConsumer)

    sinon.assert.calledTwice(bridge.configure)
    sinon.assert.calledWithExactly(bridge.configure.secondCall, { enabled: false })
    assert.strictEqual(runtime.active, false)
    assert.strictEqual(runtime.primaryConsumer, undefined)
  })

  it('keeps one physical binding for multiple consumers', () => {
    const registry = new EventSourceRegistry()
    const channel = dc.channel('datadog:test:event-source-registry')
    const handler = sinon.stub()
    const firstConsumer = {}
    const secondConsumer = {}
    const bridge = {
      configure ({ enabled }) {
        if (enabled) {
          channel.subscribe(handler)
        } else {
          channel.unsubscribe(handler)
        }
      },
    }
    const create = sinon.stub().returns(bridge)
    registry.registerSource({
      operation: 'db.query',
      source: 'mysql',
      owner: 'datadog-plugin-mysql',
      create,
    })

    registry.acquireSource('db.query', 'mysql', firstConsumer)
    registry.acquireSource('db.query', 'mysql', secondConsumer)
    channel.publish('first')

    sinon.assert.calledOnceWithExactly(handler, 'first', channel.name)
    sinon.assert.calledOnce(create)

    registry.releaseSource('db.query', 'mysql', firstConsumer)
    channel.publish('second')

    sinon.assert.calledTwice(handler)

    registry.releaseSource('db.query', 'mysql', secondConsumer)
    channel.publish('third')

    sinon.assert.calledTwice(handler)
  })

  it('reuses the source bridge after release and re-acquire', () => {
    const registry = new EventSourceRegistry()
    const bridge = { configure: sinon.stub() }
    const create = sinon.stub().returns(bridge)
    const consumer = {}
    registry.registerSource({
      operation: 'db.query',
      source: 'mysql',
      owner: 'datadog-plugin-mysql',
      create,
    })

    registry.acquireSource('db.query', 'mysql', consumer)
    registry.releaseSource('db.query', 'mysql', consumer)
    registry.acquireSource('db.query', 'mysql', consumer)

    sinon.assert.calledOnce(create)
    assert.deepStrictEqual(bridge.configure.args, [
      [{ enabled: true }],
      [{ enabled: false }],
      [{ enabled: true }],
    ])
  })

  it('activates existing and later sources for a product contributor', () => {
    const registry = new EventSourceRegistry()
    const mysqlBridge = { configure: sinon.stub() }
    const mariadbBridge = { configure: sinon.stub() }
    registry.registerSource({
      operation: 'db.query',
      source: 'mysql',
      owner: 'datadog-plugin-mysql',
      create: () => mysqlBridge,
    })

    registry.registerContributor('db.query', 'iast', {})
    registry.registerSource({
      operation: 'db.query',
      source: 'mariadb',
      owner: 'datadog-plugin-mariadb',
      create: () => mariadbBridge,
    })

    sinon.assert.calledOnceWithExactly(mysqlBridge.configure, { enabled: true })
    sinon.assert.calledOnceWithExactly(mariadbBridge.configure, { enabled: true })

    registry.unregisterContributor('db.query', 'iast')

    sinon.assert.calledWithExactly(mysqlBridge.configure.secondCall, { enabled: false })
    sinon.assert.calledWithExactly(mariadbBridge.configure.secondCall, { enabled: false })
  })

  it('composes contributor stores in registration order', () => {
    const registry = new EventSourceRegistry()
    const event = {}
    const parentStore = { parent: true }
    const firstStore = { first: true }
    const secondStore = { second: true }
    const first = sinon.stub().returns(firstStore)
    const second = sinon.stub().returns(secondStore)
    registry.registerContributor('db.query', 'first', { start: first })
    registry.registerContributor('db.query', 'second', { start: second })

    const lifecycle = registry.startContributors('db.query', event, parentStore)

    assert.strictEqual(lifecycle.store, secondStore)
    sinon.assert.calledOnceWithExactly(first, event, parentStore)
    sinon.assert.calledOnceWithExactly(second, event, firstStore)
  })

  it('isolates contributor failures and continues composing stores', () => {
    const registry = new EventSourceRegistry()
    const event = {}
    const parentStore = { parent: true }
    const finalStore = { final: true }
    const error = new Error('contributor failed')
    const logError = sinon.stub(log, 'error')
    registry.registerContributor('db.query', 'failing', {
      start () {
        throw error
      },
    })
    const succeeding = sinon.stub().returns(finalStore)
    registry.registerContributor('db.query', 'succeeding', { start: succeeding })

    try {
      const lifecycle = registry.startContributors('db.query', event, parentStore)

      assert.strictEqual(lifecycle.store, finalStore)
      sinon.assert.calledOnceWithExactly(succeeding, event, parentStore)
      sinon.assert.calledOnceWithExactly(
        logError,
        'Event contributor "%s" failed during %s: %s',
        'failing',
        'start',
        error.message
      )
    } finally {
      logError.restore()
    }
  })

  it('keeps a source active while either APM or a product contributor needs it', () => {
    const registry = new EventSourceRegistry()
    const bridge = { configure: sinon.stub() }
    const consumer = {}
    registry.registerSource({
      operation: 'db.query',
      source: 'mysql',
      owner: 'datadog-plugin-mysql',
      create: () => bridge,
    })

    registry.acquireSource('db.query', 'mysql', consumer)
    registry.registerContributor('db.query', 'iast', {})
    registry.releaseSource('db.query', 'mysql', consumer)

    sinon.assert.calledOnceWithExactly(bridge.configure, { enabled: true })

    registry.unregisterContributor('db.query', 'iast')

    sinon.assert.calledTwice(bridge.configure)
    sinon.assert.calledWithExactly(bridge.configure.secondCall, { enabled: false })
  })

  it('activates only the package sources requested by a contributor', () => {
    const registry = new EventSourceRegistry()
    const mysqlBridge = { configure: sinon.stub() }
    const mariadbCreate = sinon.stub().returns({ configure: sinon.stub() })
    const start = sinon.stub()
    registry.registerSource({
      operation: 'db.query',
      source: 'mysql',
      owner: 'datadog-plugin-mysql',
      create: () => mysqlBridge,
    })
    registry.registerSource({
      operation: 'db.query',
      source: 'mariadb',
      owner: 'datadog-plugin-mariadb',
      create: mariadbCreate,
    })

    registry.registerContributor('db.query', 'iast', {
      sources: new Set(['mysql']),
      start,
    })

    sinon.assert.calledOnceWithExactly(mysqlBridge.configure, { enabled: true })
    sinon.assert.notCalled(mariadbCreate)

    const mariadbLifecycle = registry.startContributors(
      'db.query',
      { source: { integration: 'mariadb' } }
    )
    assert.strictEqual(mariadbLifecycle, undefined)
    sinon.assert.notCalled(start)

    registry.startContributors('db.query', { source: { integration: 'mysql' } })
    sinon.assert.calledOnce(start)
  })

  it('keeps a source active until its final in-flight operation completes', () => {
    const registry = new EventSourceRegistry()
    const bridge = { configure: sinon.stub() }
    const consumer = {}
    const runtime = registry.registerSource({
      operation: 'db.query',
      source: 'mysql',
      owner: 'datadog-plugin-mysql',
      create: () => bridge,
    })
    registry.acquireSource('db.query', 'mysql', consumer)

    registry.holdOperation(runtime)
    registry.releaseSource('db.query', 'mysql', consumer)

    assert.strictEqual(runtime.active, true)
    assert.strictEqual(runtime.activeOperations, 1)
    sinon.assert.calledOnceWithExactly(bridge.configure, { enabled: true })

    registry.releaseOperation(runtime)

    assert.strictEqual(runtime.active, false)
    assert.strictEqual(runtime.activeOperations, 0)
    sinon.assert.calledWithExactly(bridge.configure.secondCall, { enabled: false })
  })

  it('keeps contributor ownership stable for an in-flight lifecycle', () => {
    const registry = new EventSourceRegistry()
    const event = { source: { integration: 'mysql' } }
    const firstFinish = sinon.stub()
    const lateFinish = sinon.stub()
    registry.registerContributor('db.query', 'first', { finish: firstFinish })

    const lifecycle = registry.startContributors('db.query', event)
    registry.unregisterContributor('db.query', 'first')
    registry.registerContributor('db.query', 'late', { finish: lateFinish })
    registry.runContributorPhase(lifecycle, 'finish')

    sinon.assert.calledOnceWithExactly(firstFinish, event, undefined)
    sinon.assert.notCalled(lateFinish)
  })

  it('rejects a second owner for an existing source key', () => {
    const registry = new EventSourceRegistry()
    const definition = {
      operation: 'db.query',
      source: 'mysql',
      owner: 'datadog-plugin-mysql',
      create: () => ({ configure () {} }),
    }
    const runtime = registry.registerSource(definition)

    assert.strictEqual(registry.registerSource(definition), runtime)
    assert.throws(
      () => registry.registerSource({ ...definition, owner: 'another-package' }),
      /Source "mysql" already registered for operation "db\.query"/
    )
    assert.throws(
      () => registry.registerSource({ ...definition, source: 'mariadb', owner: undefined }),
      /Source "mariadb" requires an owner for operation "db\.query"/
    )
  })

  it('rejects consumers for unknown operations and sources', () => {
    const registry = new EventSourceRegistry()

    assert.strictEqual(registry.getSource('db.query', 'mysql'), undefined)
    assert.throws(
      () => registry.acquireSource('db.query', 'mysql', {}),
      /No event sources registered for operation "db\.query"/
    )

    registry.registerSource({
      operation: 'db.query',
      source: 'mysql',
      owner: 'datadog-plugin-mysql',
      create: () => ({ configure () {} }),
    })

    assert.notStrictEqual(registry.getSource('db.query', 'mysql'), undefined)
    assert.throws(
      () => registry.acquireSource('db.query', 'mariadb', {}),
      /No event source "mariadb" registered for operation "db\.query"/
    )
  })

  it('rejects conflicting contributor ownership', () => {
    const registry = new EventSourceRegistry()
    const contributor = {}
    registry.registerContributor('db.query', 'iast', contributor)
    registry.registerContributor('db.query', 'iast', contributor)

    assert.throws(
      () => registry.registerContributor('db.query', 'iast', {}),
      /Contributor "iast" already registered for operation "db\.query"/
    )
  })
})
