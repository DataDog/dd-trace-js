'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const { EventSourceRegistry } = require('../../src/events/source-registry')

describe('EventSourceRegistry', () => {
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
    registry.acquireSource('db.query', 'mysql', secondConsumer)
    registry.releaseSource('db.query', 'mysql', firstConsumer)

    sinon.assert.calledOnce(create)
    sinon.assert.calledOnceWithExactly(bridge.configure, { enabled: true })
    assert.strictEqual(runtime.active, true)

    registry.releaseSource('db.query', 'mysql', secondConsumer)

    sinon.assert.calledTwice(bridge.configure)
    sinon.assert.calledWithExactly(bridge.configure.secondCall, { enabled: false })
    assert.strictEqual(runtime.active, false)
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

    const store = registry.runContributors('db.query', 'start', event, parentStore)

    assert.strictEqual(store, secondStore)
    sinon.assert.calledOnceWithExactly(first, event, parentStore)
    sinon.assert.calledOnceWithExactly(second, event, firstStore)
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

    registry.runContributors('db.query', 'start', { source: { integration: 'mariadb' } })
    sinon.assert.notCalled(start)

    registry.runContributors('db.query', 'start', { source: { integration: 'mysql' } })
    sinon.assert.calledOnce(start)
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
