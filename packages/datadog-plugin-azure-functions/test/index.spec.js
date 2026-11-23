'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../dd-trace/test/setup/core')

const { defaults } = require('../../dd-trace/src/config/defaults')
const log = require('../../dd-trace/src/log')
const web = require('../../dd-trace/src/plugins/util/web')
const AzureFunctionsPlugin = require('../src')

describe('azure-functions plugin', () => {
  let plugin
  let span
  let webContext

  beforeEach(() => {
    span = {
      addTags: sinon.stub(),
      context: () => ({ setTag: sinon.stub() }),
    }
    webContext = {}

    sinon.stub(web, 'patch').returns(webContext)
    sinon.stub(web, 'startSpan').returns(span)
    sinon.stub(web, 'startServerlessSpanWithInferredProxy').returns(span)
    sinon.stub(web, 'setRoute')

    plugin = new AzureFunctionsPlugin({
      _nomenclature: {
        opName: () => 'azure.functions.invoke',
        serviceName: () => ({ name: 'test-service' }),
      },
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  function bindHttpStart (url, semanticsEnabled) {
    plugin.configure({
      enabled: false,
      DD_TRACE_OTEL_SEMANTICS_ENABLED: semanticsEnabled,
    })
    const ctx = {
      currentStore: {},
      functionName: 'test-function',
      invocationContext: { options: { trigger: { route: 'items/{id}' } } },
      httpRequest: {
        headers: new Map([
          ['host', 'original-host'],
          ['user-agent', 'test-agent'],
        ]),
        method: 'GET',
        url,
      },
      methodName: 'http',
    }

    plugin.bindStart(ctx)
    return ctx
  }

  for (const url of [
    'http://request-host:80/path?query=value',
    'https://secure-host:443/path?query=value',
  ]) {
    it(`preserves Datadog request input with semantics disabled for ${url}`, () => {
      const ctx = bindHttpStart(url, false)
      const req = web.patch.firstCall.args[0]

      assert.deepStrictEqual(req, {
        method: 'GET',
        headers: {
          host: 'original-host',
          'user-agent': 'test-agent',
        },
        url: '/path',
      })
      assert.strictEqual(webContext.config, plugin.config)
      assert.strictEqual(webContext.tracer, plugin.tracer)
      assert.deepStrictEqual(webContext.paths, ['/path'])
      assert.strictEqual(webContext.span, span)
      assert.strictEqual(ctx.webContext, webContext)
      sinon.assert.calledOnceWithExactly(
        web.startServerlessSpanWithInferredProxy,
        plugin.tracer,
        plugin.config,
        'azure.functions.invoke',
        req,
        ctx
      )
      sinon.assert.notCalled(web.startSpan)
      sinon.assert.notCalled(web.setRoute)
    })
  }

  it('provides full URL inputs only with OTel semantics enabled', () => {
    const ctx = bindHttpStart('https://request-host:8443/path?query=value', true)
    const req = web.patch.firstCall.args[0]

    assert.deepStrictEqual(req, {
      method: 'GET',
      headers: {
        host: 'request-host:8443',
        'user-agent': 'test-agent',
      },
      url: '/path?query=value',
      socket: { encrypted: true },
    })
    sinon.assert.calledOnceWithExactly(
      web.startSpan,
      plugin.tracer,
      plugin.config,
      req,
      undefined,
      'azure.functions.invoke',
      ctx
    )
    sinon.assert.calledOnceWithExactly(web.setRoute, req, '/items/{id}')
    sinon.assert.notCalled(web.startServerlessSpanWithInferredProxy)
  })
})

describe('azure-functions HTTP invocation lifecycle', () => {
  let tracer
  let plugin

  beforeEach(() => {
    tracer = require('../../dd-trace').init({ plugins: false })
    plugin = new AzureFunctionsPlugin(tracer)
  })

  afterEach(() => {
    sinon.restore()
  })

  function bindHttpStart (search, config, route) {
    plugin.configure({ enabled: false, ...config })
    const ctx = {
      currentStore: {},
      functionName: 'test-function',
      invocationContext: { options: { trigger: { route } } },
      methodName: 'http',
      httpRequest: {
        headers: new Map([['host', 'request-host']]),
        method: 'GET',
        url: `https://request-host/api/items/42${search}`,
      },
    }

    plugin.bindStart(ctx)
    return ctx
  }

  describe('HTTP route prefixes', () => {
    let readFile

    beforeEach(() => {
      sinon.stub(process, 'env').value({ ...process.env, AzureWebJobsScriptRoot: '/azure-app' })
      delete process.env.AzureFunctionsJobHost__extensions__http__routePrefix
      readFile = sinon.stub(fs, 'readFileSync').callThrough()
      readFile.withArgs(path.join('/azure-app', 'host.json'), 'utf8').returns('{"version":"2.0"}')
    })

    for (const [prefix, expected] of [
      [undefined, '/api/items/{id}'],
      ['v2/functions', '/v2/functions/items/{id}'],
      ['', '/items/{id}'],
      [null, '/api/items/{id}'],
      [[], '/items/{id}'],
    ]) {
      it(`includes the configured prefix ${JSON.stringify(prefix)} before sampling`, () => {
        readFile.withArgs(path.join('/azure-app', 'host.json'), 'utf8').returns(JSON.stringify({
          extensions: { http: { routePrefix: prefix } },
        }))
        const { span } = bindHttpStart('', { DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, 'items/{id}')
        const tags = span.context().getTags()
        assert.strictEqual(tags['http.route'], expected)
        assert.strictEqual(tags['resource.name'], `GET ${expected}`)
      })
    }

    for (const prefix of ['custom', '']) {
      it(`gives the environment prefix ${JSON.stringify(prefix)} precedence over host.json`, () => {
        process.env.AzureFunctionsJobHost__extensions__http__routePrefix = prefix
        const { span } = bindHttpStart('', { DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, 'items/{id}')
        assert.strictEqual(span.context().getTag('http.route'), `${prefix ? `/${prefix}` : ''}/items/{id}`)
        sinon.assert.notCalled(readFile)
      })
    }

    for (const route of ['/items/{id}', 'items/{id:int?}', 'items/{*rest}']) {
      it(`preserves the function template ${route} when adding the prefix`, () => {
        const { span } = bindHttpStart('', { DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, route)
        const expected = `/api${route.startsWith('/') ? route : `/${route}`}`
        assert.strictEqual(span.context().getTag('http.route'), expected)
        assert.strictEqual(span.context().getTag('resource.name'), `GET ${expected}`)
      })
    }

    it('uses the worker working directory when the app-root environment variable is absent', () => {
      delete process.env.AzureWebJobsScriptRoot
      sinon.stub(process, 'cwd').returns('/azure-app')
      const { span } = bindHttpStart('', { DD_TRACE_OTEL_SEMANTICS_ENABLED: true })
      assert.strictEqual(span.context().getTag('http.route'), '/api/test-function')
    })

    it('caches the prefix for subsequent invocations', () => {
      bindHttpStart('', { DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, 'items/{id}')
      readFile.withArgs(path.join('/azure-app', 'host.json'), 'utf8')
        .returns('{"extensions":{"http":{"routePrefix":"new"}}}')
      const { span } = bindHttpStart('', { DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, 'items/{id}')
      assert.strictEqual(span.context().getTag('http.route'), '/api/items/{id}')
      sinon.assert.calledOnce(readFile)
    })

    for (const value of [Object.assign(new Error('unreadable'), { code: 'EACCES' }), '{invalid JSON']) {
      it(`preserves the function-relative route when configuration fails with ${String(value)}`, () => {
        const debug = sinon.spy(log, 'debug')
        const readHost = readFile.withArgs(path.join('/azure-app', 'host.json'), 'utf8')
        if (value instanceof Error) {
          readHost.throws(value)
        } else {
          readHost.returns(value)
        }
        const { span } = bindHttpStart('', { DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, 'items/{id}')
        assert.strictEqual(span.context().getTag('http.route'), '/items/{id}')
        bindHttpStart('', { DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, 'items/{id}')
        sinon.assert.calledOnce(readFile)
        sinon.assert.calledOnceWithExactly(
          debug,
          'Cannot determine Azure Functions route prefix: %s',
          value instanceof Error ? 'EACCES' : 'SyntaxError'
        )
      })
    }

    it('accepts a UTF-8 byte order mark', () => {
      readFile.withArgs(path.join('/azure-app', 'host.json'), 'utf8').returns('\uFEFF{"version":"2.0"}')
      const { span } = bindHttpStart('', { DD_TRACE_OTEL_SEMANTICS_ENABLED: true })
      assert.strictEqual(span.context().getTag('http.route'), '/api/test-function')
    })

    it('does not read host configuration with Datadog semantics', () => {
      bindHttpStart('', { DD_TRACE_OTEL_SEMANTICS_ENABLED: false })
      sinon.assert.notCalled(readFile)
    })

    it('does not read host configuration for non-HTTP invocations', () => {
      plugin.configure({ enabled: false, DD_TRACE_OTEL_SEMANTICS_ENABLED: true })
      plugin.bindStart({
        currentStore: {},
        functionName: 'test-function',
        methodName: 'cosmosDB',
      })
      sinon.assert.notCalled(readFile)
    })
  })

  for (const [route, expectedRoute] of [
    [undefined, '/test-function'],
    ['', '/test-function'],
    ['/items/{id}', '/items/{id}'],
  ]) {
    it(`sets the route and resource at start for template ${JSON.stringify(route)}`, () => {
      const { span } = bindHttpStart('', { DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, route)
      const tags = span.context().getTags()
      assert.strictEqual(tags['http.route'], expectedRoute)
      assert.strictEqual(tags['resource.name'], `GET ${expectedRoute}`)
    })
  }

  for (const [search, obfuscation, expectedSearch] of [
    ['?page=2&token=fake-token', defaults.DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP, '?page=2&<redacted>'],
    ['?page=2&private=fake-value', 'private=[^&]+', '?page=2&<redacted>'],
    ['?postcode=123&label=code%3Dexample', '', '?postcode=123&label=code%3Dexample'],
    ['?page=2&code=fake-function-key', defaults.DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP, ''],
    ['?C%4FDE=fake-function-key&C%4FDE=another-key&page=2', '', ''],
  ]) {
    it(`tags the expected URL for ${search}`, () => {
      const { span } = bindHttpStart(search, {
        DD_TRACE_OTEL_SEMANTICS_ENABLED: true,
        queryStringObfuscation: obfuscation,
      })
      assert.strictEqual(span.context().getTag('http.url'), `https://request-host/api/items/42${expectedSearch}`)
    })
  }

  for (const semanticsEnabled of [false, true]) {
    for (const status of [200, 500]) {
      it(`keeps serverless type with semantics=${semanticsEnabled} and status=${status}`, () => {
        const exportSpan = sinon.stub(tracer._tracer._exporter, 'export')
        const ctx = bindHttpStart('?query=value', { DD_TRACE_OTEL_SEMANTICS_ENABLED: semanticsEnabled })
        assert.strictEqual(ctx.span.context().getTags()['span.type'], 'serverless')

        ctx.result = { status }
        plugin.asyncStart(ctx)

        sinon.assert.calledOnce(exportSpan)
        const [span] = exportSpan.firstCall.args[0]
        assert.strictEqual(span.type, 'serverless')
        assert.strictEqual(span.error, status === 500 ? 1 : 0)
      })
    }
  }
})
