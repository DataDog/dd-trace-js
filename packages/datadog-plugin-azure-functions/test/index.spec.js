'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../dd-trace/test/setup/core')

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
    sinon.assert.calledOnceWithExactly(web.setRoute, req, '/path')
    sinon.assert.notCalled(web.startServerlessSpanWithInferredProxy)
  })
})

describe('azure-functions HTTP invocation lifecycle', () => {
  afterEach(() => {
    sinon.restore()
  })

  for (const semanticsEnabled of [false, true]) {
    for (const status of [200, 500]) {
      it(`keeps serverless type with semantics=${semanticsEnabled} and status=${status}`, () => {
        const tracer = require('../../dd-trace').init({ plugins: false })
        const exportSpan = sinon.stub(tracer._tracer._exporter, 'export')
        const plugin = new AzureFunctionsPlugin(tracer)
        plugin.configure({ enabled: false, DD_TRACE_OTEL_SEMANTICS_ENABLED: semanticsEnabled })
        const ctx = {
          currentStore: {},
          functionName: 'test-function',
          methodName: 'http',
          httpRequest: {
            headers: new Map([['host', 'request-host']]),
            method: 'GET',
            url: 'https://request-host/path?query=value',
          },
        }

        plugin.bindStart(ctx)
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
