'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const dc = require('dc-polyfill')
const sinon = require('sinon')

const { storage } = require('../../../../datadog-core')
const { createDatabaseIntegration } = require('../../../src/events/database')
const { getEventSourceRegistry } = require('../../../src/events/source-registry')
const log = require('../../../src/log')

const legacyStorage = storage('legacy')

describe('createDatabaseIntegration', () => {
  const plugins = []

  afterEach(() => {
    for (const plugin of plugins) plugin.configure(false)
    plugins.length = 0
    sinon.restore()
  })

  it('shares one physical Orchestrion bridge across tracer consumers', async () => {
    const id = 'test-database-shared-source'
    const start = sinon.stub().returns({ skip: 'parent' })
    const Integration = createIntegration(id, { start })
    const first = new Integration(createTracer('first'), createTracerConfig())
    const second = new Integration(createTracer('second'), createTracerConfig())
    plugins.push(first, second)

    first.configure({ enabled: true })
    second.configure({ enabled: true })

    const runtime = getEventSourceRegistry().getSource('db.query', id)
    assert.strictEqual(runtime.consumers.size, 2)
    assert.strictEqual(runtime.instance._bindings.length, 1)
    assert.strictEqual(runtime.instance._subscriptions.length, 3)

    const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)
    const context = { arguments: [] }
    assert.strictEqual(await channel.tracePromise(() => Promise.resolve('first'), context), 'first')
    sinon.assert.calledOnceWithExactly(start, context)

    first.configure(false)
    assert.strictEqual(runtime.active, true)
    await channel.tracePromise(() => Promise.resolve('second'), { arguments: [] })
    sinon.assert.calledTwice(start)

    second.configure(false)
    assert.strictEqual(runtime.active, false)
    await channel.tracePromise(() => Promise.resolve('disabled'), { arguments: [] })
    sinon.assert.calledTwice(start)
  })

  it('shares one physical diagnostic-channel bridge across tracer consumers', () => {
    const id = 'test-database-shared-channel-source'
    const source = {
      start: sinon.stub().returns({ statement: 'SELECT 1' }),
    }
    const Integration = createChannelIntegration(id, source)
    const firstSpan = createSpan()
    const secondSpan = createSpan()
    const first = new Integration(createTracer('first', firstSpan), createTracerConfig())
    const second = new Integration(createTracer('second', secondSpan), createTracerConfig())
    plugins.push(first, second)

    first.configure({ enabled: true })
    second.configure({ enabled: true })

    const runtime = getEventSourceRegistry().getSource('db.query', id)
    assert.strictEqual(runtime.consumers.size, 2)
    assert.strictEqual(runtime.instance._bindings.length, 2)
    assert.strictEqual(runtime.instance._subscriptions.length, 2)

    const context = { sql: 'SELECT 1' }
    const parentStore = { parent: true }
    legacyStorage.run(parentStore, () => dc.channel(`test:${id}:start`).runStores(context, () => {}))
    dc.channel(`test:${id}:finish`).runStores(context, () => {
      assert.strictEqual(legacyStorage.getStore(), parentStore)
    })

    sinon.assert.calledOnce(source.start)
    sinon.assert.calledOnce(firstSpan.finish)
    sinon.assert.calledOnce(secondSpan.finish)

    first.configure(false)
    second.configure(false)
    dc.channel(`test:${id}:start`).runStores({ sql: 'SELECT 2' }, () => {})
    sinon.assert.calledOnce(source.start)
  })

  it('starts and finishes one trace per tracer through the shared bridge', async () => {
    const id = 'test-database-multiple-tracers'
    const source = {
      start: sinon.stub().returns({
        connection: { database: 'database' },
        statement: 'SELECT 1',
      }),
    }
    const Integration = createIntegration(id, source)
    const firstSpan = createSpan()
    const secondSpan = createSpan()
    const first = new Integration(createTracer('first', firstSpan), createTracerConfig())
    const second = new Integration(createTracer('second', secondSpan), createTracerConfig())
    plugins.push(first, second)
    first.configure({ enabled: true })
    second.configure({ enabled: true })
    const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)

    await channel.tracePromise(() => Promise.resolve(), { arguments: [] })

    sinon.assert.calledOnce(source.start)
    sinon.assert.calledOnce(firstSpan.finish)
    sinon.assert.calledOnce(secondSpan.finish)
  })

  it('records an error for every tracer through the shared bridge', async () => {
    const id = 'test-database-multiple-tracer-error'
    const source = {
      start: sinon.stub().returns({ statement: 'SELECT 1' }),
    }
    const Integration = createIntegration(id, source)
    const firstSpan = createSpan()
    const secondSpan = createSpan()
    const first = new Integration(createTracer('first', firstSpan), createTracerConfig())
    const second = new Integration(createTracer('second', secondSpan), createTracerConfig())
    plugins.push(first, second)
    first.configure({ enabled: true })
    second.configure({ enabled: true })
    const applicationError = new Error('query failed')
    const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)

    await assert.rejects(
      channel.tracePromise(() => Promise.reject(applicationError), { arguments: [] }),
      applicationError
    )

    sinon.assert.calledOnceWithExactly(firstSpan.setTag, 'error', applicationError)
    sinon.assert.calledOnceWithExactly(secondSpan.setTag, 'error', applicationError)
    sinon.assert.calledOnce(firstSpan.finish)
    sinon.assert.calledOnce(secondSpan.finish)
  })

  it('publishes normalized facts to product contributors without exposing raw package arguments', async () => {
    const id = 'test-database-product-source'
    const facts = { statement: 'SELECT 1' }
    const source = {
      complete: sinon.stub().returns({ rowCount: 1 }),
      start: sinon.stub().returns(facts),
    }
    createIntegration(id, source)
    const sourceRegistry = getEventSourceRegistry()
    const start = sinon.stub().returns({ product: true })
    const finish = sinon.stub()
    sourceRegistry.registerContributor('db.query', `${id}-contributor`, {
      sources: new Set([id]),
      finish,
      start,
    })

    try {
      const rawContext = { arguments: [{ secret: true }] }
      const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)
      await channel.tracePromise(() => Promise.resolve({ rows: [] }), rawContext)

      const event = start.firstCall.args[0]
      assert.strictEqual(event.facts, facts)
      assert.strictEqual(event.source.integration, id)
      assert.strictEqual(event.arguments, undefined)
      assert.strictEqual(event.result, undefined)
      assert.strictEqual(event.consumer, undefined)
      assert.strictEqual(event.currentStore, undefined)
      assert.strictEqual(event.parentStore, undefined)
      sinon.assert.calledOnceWithExactly(start, event, undefined)
      sinon.assert.calledOnceWithExactly(source.complete, rawContext)
      sinon.assert.calledOnceWithExactly(finish, event, { product: true })
      assert.deepStrictEqual(event.metadata, { rowCount: 1 })
    } finally {
      sourceRegistry.unregisterContributor('db.query', `${id}-contributor`)
    }
  })

  it('keeps the physical bridge active until an in-flight operation finishes', async () => {
    const id = 'test-database-in-flight-disable'
    const source = {
      start: sinon.stub().returns({ statement: 'SELECT 1' }),
    }
    const Integration = createIntegration(id, source)
    const span = createSpan()
    const plugin = new Integration(createTracer('in-flight', span), createTracerConfig())
    plugins.push(plugin)
    plugin.configure({ enabled: true })
    const runtime = getEventSourceRegistry().getSource('db.query', id)
    const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)
    let finishApplication = () => {}
    const application = new Promise(resolve => {
      finishApplication = resolve
    })

    const traced = channel.tracePromise(() => application, { arguments: [] })
    plugin.configure(false)

    assert.strictEqual(runtime.active, true)
    assert.strictEqual(runtime.activeOperations, 1)
    sinon.assert.notCalled(span.finish)

    finishApplication()
    await traced

    assert.strictEqual(runtime.active, false)
    assert.strictEqual(runtime.activeOperations, 0)
    sinon.assert.calledOnce(span.finish)
  })

  it('composes a product contributor store before starting APM tracing', async () => {
    const id = 'test-database-product-and-apm-source'
    const source = {
      start: sinon.stub().returns({ statement: 'SELECT 1' }),
    }
    const Integration = createIntegration(id, source)
    const span = createSpan()
    const plugin = new Integration(createTracer('apm', span), createTracerConfig())
    plugins.push(plugin)
    plugin.configure({ enabled: true })
    const productStore = { product: true }
    const sourceRegistry = getEventSourceRegistry()
    sourceRegistry.registerContributor('db.query', `${id}-contributor`, {
      sources: new Set([id]),
      start: sinon.stub().returns(productStore),
    })

    try {
      const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)
      await channel.tracePromise(() => {
        const store = legacyStorage.getStore()
        assert.strictEqual(store.product, true)
        assert.strictEqual(store.span, span)
        return Promise.resolve()
      }, { arguments: [] })

      sinon.assert.calledOnce(span.finish)
    } finally {
      sourceRegistry.unregisterContributor('db.query', `${id}-contributor`)
    }
  })

  it('isolates package extraction failures from application calls', async () => {
    const id = 'test-database-failing-source'
    const error = new Error('extractor failed')
    const start = sinon.stub().throws(error)
    const logError = sinon.stub(log, 'error')
    const Integration = createIntegration(id, { start })
    const plugin = new Integration(createTracer('failing'), createTracerConfig())
    plugins.push(plugin)
    plugin.configure({ enabled: true })

    const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)
    const result = await channel.tracePromise(() => Promise.resolve('application result'), { arguments: [] })

    assert.strictEqual(result, 'application result')
    sinon.assert.calledOnceWithExactly(
      logError,
      'Database source "%s" failed during start: %s',
      id,
      error.message
    )
  })

  it('publishes async error and finish phases exactly once', async () => {
    const id = 'test-database-error-source'
    const source = {
      complete: sinon.stub().returns({ status: 409 }),
      start: sinon.stub().returns({ statement: 'INSERT' }),
    }
    createIntegration(id, source)
    const sourceRegistry = getEventSourceRegistry()
    const error = sinon.stub()
    const finish = sinon.stub()
    sourceRegistry.registerContributor('db.query', `${id}-contributor`, {
      error,
      finish,
      sources: new Set([id]),
    })

    try {
      const applicationError = new Error('query failed')
      const rawContext = { arguments: [] }
      const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)
      await assert.rejects(channel.tracePromise(() => Promise.reject(applicationError), rawContext), applicationError)

      const event = error.firstCall.args[0]
      assert.strictEqual(event.error, applicationError)
      assert.deepStrictEqual(event.metadata, { status: 409 })
      sinon.assert.calledOnceWithExactly(error, event, undefined)
      sinon.assert.calledOnceWithExactly(finish, event, undefined)
      sinon.assert.calledOnceWithExactly(source.complete, rawContext)

      dc.channel(`tracing:orchestrion:test:${id}:query:asyncEnd`).publish(rawContext)
      sinon.assert.calledOnce(error)
      sinon.assert.calledOnce(finish)
      sinon.assert.calledOnce(source.complete)
    } finally {
      sourceRegistry.unregisterContributor('db.query', `${id}-contributor`)
    }
  })

  it('isolates package completion failures and still runs product finish', async () => {
    const id = 'test-database-completion-failure-source'
    const completionError = new Error('completion failed')
    const source = {
      complete: sinon.stub().throws(completionError),
      start: sinon.stub().returns({ statement: 'SELECT 1' }),
    }
    createIntegration(id, source)
    const sourceRegistry = getEventSourceRegistry()
    const finish = sinon.stub()
    const logError = sinon.stub(log, 'error')
    sourceRegistry.registerContributor('db.query', `${id}-contributor`, {
      finish,
      sources: new Set([id]),
    })

    try {
      const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)
      const result = await channel.tracePromise(() => Promise.resolve('application result'), { arguments: [] })

      assert.strictEqual(result, 'application result')
      sinon.assert.calledOnce(finish)
      sinon.assert.calledOnceWithExactly(
        logError,
        'Database source "%s" failed during completion: %s',
        id,
        completionError.message
      )
    } finally {
      sourceRegistry.unregisterContributor('db.query', `${id}-contributor`)
    }
  })

  it('maps synchronous Orchestrion completion to the same semantic lifecycle', () => {
    const id = 'test-database-sync-source'
    const source = {
      complete: sinon.stub().returns({ rowCount: 1 }),
      start: sinon.stub().returns({ statement: 'SELECT 1' }),
    }
    createIntegration(id, source, 'sync')
    const sourceRegistry = getEventSourceRegistry()
    const finish = sinon.stub()
    sourceRegistry.registerContributor('db.query', `${id}-contributor`, {
      finish,
      sources: new Set([id]),
    })

    try {
      const rawContext = { arguments: [] }
      const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)
      assert.strictEqual(channel.traceSync(() => 'result', rawContext), 'result')

      sinon.assert.calledOnceWithExactly(source.complete, rawContext)
      sinon.assert.calledOnce(finish)
      assert.deepStrictEqual(finish.firstCall.args[0].metadata, { rowCount: 1 })
    } finally {
      sourceRegistry.unregisterContributor('db.query', `${id}-contributor`)
    }
  })

  it('releases synchronous failures through the same terminal lifecycle', () => {
    const id = 'test-database-sync-error-source'
    const source = {
      start: sinon.stub().returns({ statement: 'SELECT 1' }),
    }
    const Integration = createIntegration(id, source, 'sync')
    const span = createSpan()
    const plugin = new Integration(createTracer('sync-error', span), createTracerConfig())
    plugins.push(plugin)
    plugin.configure({ enabled: true })
    const applicationError = new Error('query failed')
    const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)

    assert.throws(
      () => channel.traceSync(() => { throw applicationError }, { arguments: [] }),
      applicationError
    )

    const runtime = getEventSourceRegistry().getSource('db.query', id)
    assert.strictEqual(runtime.activeOperations, 0)
    sinon.assert.calledOnceWithExactly(span.setTag, 'error', applicationError)
    sinon.assert.calledOnce(span.finish)
  })

  it('writes shared query updates back through the package source adapter', async () => {
    const id = 'test-database-writeback-source'
    const facts = {
      connection: { database: 'database' },
      statement: 'SELECT 1',
    }
    const source = {
      start: sinon.stub().returns(facts),
      updateSource: sinon.stub(),
    }
    const Integration = createIntegration(id, source, 'async', 'mariadb')
    const span = createSpan()
    const plugin = new Integration(createTracer('writeback', span), createTracerConfig())
    plugins.push(plugin)
    plugin.configure({ dbmPropagationMode: 'service', enabled: true })
    const rawContext = { arguments: ['SELECT 1'] }
    const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)

    await channel.tracePromise(() => Promise.resolve(), rawContext)

    const updates = source.updateSource.firstCall.args[2]
    sinon.assert.calledOnceWithExactly(source.updateSource, rawContext, facts, updates)
    assert.match(updates.statement,
      /^\/\*dddb='database',dddbs='writeback-test-database-writeback-source'/)
    assert.match(updates.statement, /\*\/ SELECT 1$/)
    sinon.assert.calledOnce(span.finish)
  })

  it('uses only the primary tracer for one physical statement update', async () => {
    const id = 'test-database-primary-writeback-source'
    const source = {
      start: sinon.stub().returns({
        connection: { database: 'database' },
        statement: 'SELECT 1',
      }),
      updateSource: sinon.stub(),
    }
    const Integration = createIntegration(id, source, 'async', 'mariadb')
    const firstSpan = createSpan()
    const secondSpan = createSpan()
    const first = new Integration(createTracer('first', firstSpan), createTracerConfig())
    const second = new Integration(createTracer('second', secondSpan), createTracerConfig())
    plugins.push(first, second)
    first.configure({ dbmPropagationMode: 'service', enabled: true })
    second.configure({ dbmPropagationMode: 'service', enabled: true })
    const rawContext = { arguments: ['SELECT 1'] }
    const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)

    await channel.tracePromise(() => Promise.resolve(), rawContext)

    sinon.assert.calledOnce(source.updateSource)
    const statement = source.updateSource.firstCall.args[2].statement
    assert.match(statement, /dddbs='first-test-database-primary-writeback-source'/)
    assert.strictEqual((statement.match(/\/\*dddb=/g) || []).length, 1)
    sinon.assert.calledOnce(firstSpan.finish)
    sinon.assert.calledOnce(secondSpan.finish)
  })

  it('isolates package source update failures and still finishes tracing', async () => {
    const id = 'test-database-writeback-failure-source'
    const updateError = new Error('update failed')
    const source = {
      start: sinon.stub().returns({ statement: 'SELECT 1' }),
      updateSource: sinon.stub().throws(updateError),
    }
    const Integration = createIntegration(id, source, 'async', 'mariadb')
    const span = createSpan()
    const plugin = new Integration(createTracer('writeback-failure', span), createTracerConfig())
    const logError = sinon.stub(log, 'error')
    plugins.push(plugin)
    plugin.configure({ dbmPropagationMode: 'service', enabled: true })
    const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)

    const result = await channel.tracePromise(() => Promise.resolve('application result'), {})

    assert.strictEqual(result, 'application result')

    sinon.assert.calledOnceWithExactly(
      logError,
      'Database source "%s" failed during source update: %s',
      id,
      updateError.message
    )
    sinon.assert.calledOnce(span.finish)
  })

  it('preserves inherited no-op stores without running package extraction', async () => {
    const id = 'test-database-noop-source'
    const start = sinon.stub().returns({ statement: 'SELECT 1' })
    const Integration = createIntegration(id, { start })
    const plugin = new Integration(createTracer('noop'), createTracerConfig())
    plugins.push(plugin)
    plugin.configure({ enabled: true })
    const noopStore = { noop: true }
    const channel = dc.tracingChannel(`orchestrion:test:${id}:query`)

    await legacyStorage.run(noopStore, () => channel.tracePromise(() => {
      assert.strictEqual(legacyStorage.getStore(), noopStore)
      return Promise.resolve()
    }, { arguments: [] }))

    sinon.assert.notCalled(start)
  })

  it('routes pool acquisition and connection context through fixed shared adapters', () => {
    const id = 'test-database-pool-source'
    const source = {
      complete: sinon.stub().returns({ 'testdb.pool.wait_time': 7 }),
      start: sinon.stub().returns({
        connection: { database: 'database', host: 'localhost', port: 3306, user: 'user' },
      }),
    }
    const Integration = createPoolIntegration(id, source)
    const span = createSpan()
    const plugin = new Integration(createTracer('pool', span), createTracerConfig())
    plugins.push(plugin)
    plugin.configure({ enabled: true })

    const runtime = getEventSourceRegistry().getSource('db.pool.acquire', id)
    assert.strictEqual(runtime.instance._bindings.length, 2)
    assert.strictEqual(runtime.instance._subscriptions.length, 3)

    const parentStore = { parent: true }
    const connectionContext = {}
    legacyStorage.run(parentStore, () => dc.channel(`test:${id}:connection:start`).publish(connectionContext))
    dc.channel(`test:${id}:connection:finish`).runStores(connectionContext, () => {
      assert.strictEqual(legacyStorage.getStore(), parentStore)
    })
    dc.channel(`test:${id}:skip`).runStores({}, () => {
      assert.deepStrictEqual(legacyStorage.getStore(), { noop: true })
    })

    const acquireContext = { conf: {}, poolWaitTime: 7 }
    legacyStorage.run(parentStore, () => dc.channel(`test:${id}:acquire:start`).publish(acquireContext))
    dc.channel(`test:${id}:acquire:finish`).publish(acquireContext)

    sinon.assert.calledOnceWithExactly(source.start, acquireContext)
    sinon.assert.calledOnceWithExactly(source.complete, acquireContext)
    sinon.assert.calledOnceWithExactly(span.addTags, { 'testdb.pool.wait_time': 7 })
    sinon.assert.calledOnce(span.finish)
  })

  it('validates the fixed database lifecycle contract', () => {
    assert.throws(
      () => createDatabaseIntegration(),
      /Database integration requires a non-empty id/
    )
    assert.throws(
      () => createDatabaseIntegration({ id: 'invalid', operations: [], system: '' }),
      /requires a non-empty system/
    )
    assert.throws(
      () => createDatabaseIntegration({ id: 'invalid', operations: [], system: 'test' }),
      /requires database operations/
    )
    assert.throws(
      () => createDatabaseIntegration({ base: class {}, id: 'invalid', operations: [], system: 'test' }),
      /requires a Plugin base/
    )
    assert.throws(
      () => createDatabaseIntegration({
        id: 'invalid',
        operations: [{ adapter: 'pool.acquire', operation: 'db.query', source: {} }],
        system: 'test',
      }),
      /has an invalid lifecycle adapter/
    )
    assert.throws(
      () => createDatabaseIntegration({
        id: 'invalid',
        operations: [{ adapter: 'query', operation: 'db.query', source: {} }],
        system: 'test',
      }),
      /requires a query source with targets/
    )
    assert.throws(
      () => createDatabaseIntegration({
        id: 'invalid-target',
        operations: [{
          adapter: 'query',
          operation: 'db.query',
          source: { start () {}, targets: [{ lifecycle: 'later', module: 'test', name: 'query' }] },
        }],
        system: 'test',
      }),
      /has an invalid query target/
    )
    assert.throws(
      () => createDatabaseIntegration({
        id: 'invalid-channel-target',
        operations: [{
          adapter: 'query',
          operation: 'db.query',
          source: { start () {}, targets: [{ channels: { finish: 'finish', start: 'start' } }] },
        }],
        system: 'test',
      }),
      /has an invalid query target/
    )
    assert.throws(
      () => createDatabaseIntegration({
        id: 'ambiguous-target',
        operations: [{
          adapter: 'query',
          operation: 'db.query',
          source: {
            start () {},
            targets: [{
              channels: { finish: 'finish', start: 'start' },
              lifecycle: 'async',
              module: 'test',
              name: 'query',
            }],
          },
        }],
        system: 'test',
      }),
      /has an invalid query target/
    )
    assert.throws(
      () => createDatabaseIntegration({
        id: 'duplicate-target',
        operations: [{
          adapter: 'query',
          operation: 'db.query',
          source: {
            start () {},
            targets: [
              { lifecycle: 'sync', module: 'test', name: 'query' },
              { lifecycle: 'async', module: 'test', name: 'query' },
            ],
          },
        }],
        system: 'test',
      }),
      /repeats query target "test:query"/
    )
  })
})

function createIntegration (id, source, lifecycle = 'async', system = 'testdb') {
  source.targets = [{
    lifecycle,
    module: 'test',
    name: `${id}:query`,
  }]

  return createDatabaseIntegration({
    id,
    operations: [{
      adapter: 'query',
      operation: 'db.query',
      source,
    }],
    schema: false,
    system,
  })
}

function createChannelIntegration (id, source) {
  source.targets = [{
    channels: {
      error: `test:${id}:error`,
      finish: `test:${id}:finish`,
      start: `test:${id}:start`,
    },
  }]

  return createDatabaseIntegration({
    id,
    operations: [{
      adapter: 'query',
      operation: 'db.query',
      source,
    }],
    schema: false,
    system: 'testdb',
  })
}

function createPoolIntegration (id, source) {
  source.connection = {
    finish: `test:${id}:connection:finish`,
    skip: `test:${id}:skip`,
    start: `test:${id}:connection:start`,
  }
  source.targets = [{
    channels: {
      finish: `test:${id}:acquire:finish`,
      start: `test:${id}:acquire:start`,
    },
  }]

  return createDatabaseIntegration({
    id,
    operations: [{
      adapter: 'pool.acquire',
      operation: 'db.pool.acquire',
      source,
    }],
    schema: false,
    system: 'testdb',
  })
}

function createTracer (service, span) {
  const tracer = {
    _env: 'test',
    _service: service,
    _version: '1.0.0',
  }
  if (span) tracer.startSpan = sinon.stub().returns(span)

  return tracer
}

function createTracerConfig () {
  return {
    codeOriginForSpans: {
      enabled: false,
      experimental: { exit_spans: { enabled: false } },
    },
    spanComputePeerService: false,
  }
}

function createSpan () {
  const tags = {
    'db.name': 'database',
    'out.host': 'localhost',
  }
  return {
    addTags: sinon.stub(),
    context: sinon.stub().returns({
      getTag: name => tags[name],
      getTags: () => tags,
    }),
    finish: sinon.stub(),
    setTag: sinon.stub(),
  }
}
