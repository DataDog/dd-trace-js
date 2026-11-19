'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../dd-trace/test/setup/core')

const { defaults } = require('../../dd-trace/src/config/defaults')
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
