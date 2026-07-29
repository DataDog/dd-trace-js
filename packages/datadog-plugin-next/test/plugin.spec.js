'use strict'

const assert = require('node:assert/strict')

const { describe, afterEach, it } = require('mocha')
const proxyquire = require('proxyquire')

const { storage } = require('../../datadog-core')

const legacyStorage = storage('legacy')

describe('next plugin', () => {
  afterEach(() => {
    legacyStorage.enterWith(undefined)
  })

  it('extracts incoming distributed context when Next starts without an HTTP parent', () => {
    const headers = {
      'x-datadog-trace-id': '123',
      'x-datadog-parent-id': '456',
    }
    const extractedContext = { traceId: '123', spanId: '456' }
    const extractCalls = []
    const plugin = createPlugin({
      extractIncomingServerContext: (tracer, carrier) => {
        extractCalls.push({ tracer, carrier })
        return extractedContext
      },
    })

    const store = plugin.bindStart({
      req: { method: 'GET', headers },
      res: {},
    })

    assert.deepStrictEqual(extractCalls, [{ tracer: plugin.tracer, carrier: headers }])
    assert.strictEqual(plugin.tracer.spans[0].name, 'next.request')
    assert.strictEqual(plugin.tracer.spans[0].options.childOf, extractedContext)
    assert.strictEqual(store.span, plugin.tracer.spans[0])
  })

  it('keeps an active HTTP parent instead of extracting a second context', () => {
    const parentSpan = createSpan('http.request')
    const plugin = createPlugin({
      extractIncomingServerContext: () => {
        throw new Error('should not extract when an HTTP parent exists')
      },
    })

    legacyStorage.run({ span: parentSpan }, () => {
      plugin.bindStart({
        req: { method: 'GET', headers: {} },
        res: {},
      })
    })

    assert.strictEqual(plugin.tracer.spans[0].options.childOf, parentSpan)
  })

  it('refines its parent route without replacing it with a static fallback', () => {
    const parentSpan = createSpan('http.request')
    parentSpan._integrationName = 'http'
    const plugin = createPlugin()
    let store

    legacyStorage.run({ span: parentSpan }, () => {
      store = plugin.bindStart({ req: { method: 'GET', headers: {}, url: '/hello/world' }, res: {} })
    })

    legacyStorage.run(store, () => {
      plugin.pageLoad({ page: '/hello/world' })
      plugin.pageLoad({ page: '/hello/[name]' })
      plugin.pageLoad({ page: '/test.txt', isStatic: true })
    })

    assert.strictEqual(parentSpan.context().getTag('http.route'), '/hello/[name]')
    assert.strictEqual(parentSpan.context().getTag('resource.name'), 'GET /hello/[name]')
  })

  it('does not replace a route established before Next runs', () => {
    const parentSpan = createSpan('http.request')
    parentSpan._integrationName = 'http'
    parentSpan.setTag('http.route', '/upstream/[id]')
    parentSpan.setTag('resource.name', 'GET /upstream/[id]')
    const plugin = createPlugin()
    let store

    legacyStorage.run({ span: parentSpan }, () => {
      store = plugin.bindStart({ req: { method: 'GET', headers: {}, url: '/hello/world' }, res: {} })
    })

    legacyStorage.run(store, () => {
      plugin.pageLoad({ page: '/hello/[name]' })
    })

    assert.strictEqual(parentSpan.context().getTag('http.route'), '/upstream/[id]')
    assert.strictEqual(parentSpan.context().getTag('resource.name'), 'GET /upstream/[id]')
  })
})

function createPlugin (web) {
  const NextPlugin = proxyquire.noCallThru().load('../src', {
    '../../dd-trace/src/plugins/util/web': {
      extractIncomingServerContext: () => undefined,
      setRoute: () => {},
      ...web,
    },
  })
  const tracer = createTracer()
  return new NextPlugin(tracer, {})
}

function createTracer () {
  return {
    _service: 'test-service',
    _nomenclature: {
      serviceName: () => ({ name: 'next-service', source: 'schema' }),
      opName: () => 'next.request',
    },
    spans: [],
    startSpan (name, options) {
      const span = createSpan(name, options)
      this.spans.push(span)
      return span
    },
  }
}

function createSpan (name, options = {}) {
  const tags = {}
  const context = {
    _name: name,
    getTag: key => tags[key],
  }

  return {
    _integrationName: options.integrationName,
    context: () => context,
    name,
    options,
    setTag: (key, value) => {
      tags[key] = value
    },
    addTags: newTags => {
      Object.assign(tags, newTags)
    },
  }
}
