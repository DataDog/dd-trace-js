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

  it('extracts incoming context when Next starts the request span without an HTTP parent', () => {
    const headers = {
      'x-datadog-trace-id': '123',
      'x-datadog-parent-id': '456',
    }
    const extractedContext = { traceId: '123', spanId: '456' }
    const extractCalls = []
    const plugin = createPlugin({
      web: {
        extractIncomingServerContext: (tracer, carrier) => {
          extractCalls.push({ tracer, carrier })
          return extractedContext
        },
      },
    })

    const store = plugin.bindStart({
      req: { method: 'GET', headers },
      res: {},
    })

    assert.strictEqual(extractCalls.length, 1)
    assert.strictEqual(extractCalls[0].tracer, plugin.tracer)
    assert.strictEqual(extractCalls[0].carrier, headers)
    assert.strictEqual(plugin.tracer.spans[0].name, 'next.request')
    assert.strictEqual(plugin.tracer.spans[0].options.childOf, extractedContext)
    assert.strictEqual(store.span, plugin.tracer.spans[0])
  })

  it('keeps the existing HTTP parent when one is already active', () => {
    const parentSpan = createSpan('http.request')
    const plugin = createPlugin({
      web: {
        extractIncomingServerContext: () => {
          throw new Error('should not extract when an HTTP parent exists')
        },
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

  it('reuses an active Next request span for compiled runtime re-entry', () => {
    const parentSpan = createSpan('next.request', { integrationName: 'next' })
    const plugin = createPlugin()
    const req = { method: 'GET', headers: {}, url: '/api/ping' }
    let store

    legacyStorage.run({ span: parentSpan }, () => {
      store = plugin.bindStart({ req, res: {} })
    })

    assert.strictEqual(plugin.tracer.spans.length, 0)
    assert.strictEqual(store.span, parentSpan)
    assert.strictEqual(store.req, req)

    legacyStorage.run(store, () => {
      plugin.pageLoad({ page: '/api/ping', isAppPath: true, isFilesystemPath: false })
      plugin.finish({ req, res: { statusCode: 200 } })
    })

    assert.strictEqual(parentSpan.tags['resource.name'], 'GET /api/ping')
    assert.strictEqual(parentSpan.finishCalls, 0)
  })

  it('records compiled runtime errors without finishing a reused Next span', () => {
    const error = new Error('compiled runtime failed')
    const parentSpan = createSpan('next.request', { integrationName: 'next' })
    const plugin = createPlugin()
    const req = { method: 'GET', headers: {}, url: '/api/fail' }
    let store

    legacyStorage.run({ span: parentSpan }, () => {
      store = plugin.bindStart({ req, res: {} })
    })

    legacyStorage.run(store, () => {
      plugin.error({ error })
      plugin.finish({ req, res: { statusCode: 500 } })
    })

    assert.strictEqual(parentSpan.context().getTag('error'), error)
    assert.strictEqual(parentSpan.finishCalls, 0)
  })

  for (const [page, isAppPath, expected] of [
    ['/index', false, '/'],
    ['/nested/index', false, '/nested'],
    ['/page', true, '/'],
    ['/route', true, '/'],
    ['/nested/page', true, '/nested'],
    ['/nested/route', true, '/nested'],
  ]) {
    it(`normalizes filesystem route ${page}`, () => {
      const setRouteCalls = []
      const plugin = createPlugin({
        web: {
          setRoute: (req, route) => setRouteCalls.push({ req, route }),
        },
      })
      const req = { method: 'GET', headers: {}, url: expected }
      const span = createSpan('next.request')

      legacyStorage.run({ span, req }, () => {
        plugin.pageLoad({ page, isAppPath, isFilesystemPath: true })
      })

      assert.strictEqual(span.tags['resource.name'], `GET ${expected}`)
      assert.strictEqual(span.tags['next.page'], expected)
      assert.deepStrictEqual(setRouteCalls, [{ req, route: expected }])
    })
  }

  for (const page of ['/index', '/page', '/route', '/nested/index', '/nested/page', '/nested/route']) {
    it(`preserves normalized pathname ${page}`, () => {
      const setRouteCalls = []
      const plugin = createPlugin({
        web: {
          setRoute: (req, route) => setRouteCalls.push({ req, route }),
        },
      })
      const req = { method: 'GET', headers: {}, url: page }
      const span = createSpan('next.request')

      legacyStorage.run({ span, req }, () => {
        plugin.pageLoad({ page, isAppPath: true, isFilesystemPath: false })
      })

      assert.strictEqual(span.tags['resource.name'], `GET ${page}`)
      assert.strictEqual(span.tags['next.page'], page)
      assert.deepStrictEqual(setRouteCalls, [{ req, route: page }])
    })
  }

  it('updates an unnamed HTTP parent with the Next route', () => {
    const plugin = createPlugin()
    const parentSpan = createSpan('web.request', { integrationName: 'http' })
    const req = { method: 'GET', headers: {}, url: '/api/parallel' }
    let nextStore

    legacyStorage.run({ span: parentSpan }, () => {
      nextStore = plugin.bindStart({ req, res: {} })
    })
    legacyStorage.run(nextStore, () => {
      plugin.pageLoad({ page: '/api/parallel', isAppPath: true, isFilesystemPath: false })
    })

    assert.strictEqual(parentSpan.tags['http.route'], '/api/parallel')
    assert.strictEqual(parentSpan.tags['resource.name'], 'GET /api/parallel')
  })

  it('preserves an existing HTTP parent route', () => {
    const plugin = createPlugin()
    const parentSpan = createSpan('web.request', { integrationName: 'http' })
    const req = { method: 'GET', headers: {}, url: '/api/parallel' }
    let nextStore

    parentSpan.setTag('http.route', '/existing')
    parentSpan.setTag('resource.name', 'GET /existing')
    legacyStorage.run({ span: parentSpan }, () => {
      nextStore = plugin.bindStart({ req, res: {} })
    })
    legacyStorage.run(nextStore, () => {
      plugin.pageLoad({ page: '/api/parallel', isAppPath: true, isFilesystemPath: false })
    })

    assert.strictEqual(parentSpan.tags['http.route'], '/existing')
    assert.strictEqual(parentSpan.tags['resource.name'], 'GET /existing')
  })
})

function createPlugin ({ web = {} } = {}) {
  web = {
    extractIncomingServerContext: () => undefined,
    setRoute: () => {},
    ...web,
  }

  const NextPlugin = proxyquire.noCallThru().load('../src', {
    '../../dd-trace/src/plugins/util/web': web,
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
    setTag: (key, value) => {
      tags[key] = value
    },
  }

  return {
    _integrationName: options.integrationName,
    name,
    options,
    tags,
    finishCalls: 0,
    context: () => context,
    setTag: (key, value) => {
      tags[key] = value
    },
    addTags: newTags => {
      Object.assign(tags, newTags)
    },
    finish () {
      this.finishCalls++
    },
  }
}
