'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')
const tagsExt = require('../../../../../ext/tags')

const ERROR = tagsExt.ERROR
const HTTP_CLIENT_IP = tagsExt.HTTP_CLIENT_IP
const HTTP_ENDPOINT = tagsExt.HTTP_ENDPOINT
const HTTP_REQUEST_HEADERS = tagsExt.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tagsExt.HTTP_RESPONSE_HEADERS
const HTTP_ROUTE = tagsExt.HTTP_ROUTE
const RESOURCE_NAME = tagsExt.RESOURCE_NAME

describe('plugins/util/web', () => {
  let web
  let tracer
  let span
  let req
  let res
  let end
  let config
  let tags

  beforeEach(() => {
    req = {
      method: 'GET',
      headers: {
        host: 'localhost',
        date: 'now',
      },
    }
    end = sinon.stub()
    res = {
      statusCode: 200,
      end,
      getHeader: sinon.stub(),
      getHeaders: sinon.stub().returns({}),
      setHeader: sinon.spy(),
      writeHead: () => {},
    }
    res.getHeader.withArgs('server').returns('test')
    config = { hooks: {} }

    tracer = require('../../..').init({ plugins: false })
    web = require('../../../src/plugins/util/web')
    config = web.normalizeConfig(config)
  })

  describe('normalizeConfig', () => {
    it('should set the correct defaults', () => {
      const config = web.normalizeConfig({})

      assert.ok(Object.hasOwn(config, 'headers'))
      assert.ok(Array.isArray(config.headers))
      assert.ok(Object.hasOwn(config, 'validateStatus'))
      assert.strictEqual(typeof config.validateStatus, 'function')
      assert.strictEqual(config.validateStatus(200), true)
      assert.strictEqual(config.validateStatus(500), false)
      assert.ok(Object.hasOwn(config, 'hooks'))
      assert.ok(typeof config.hooks === 'object' && config.hooks !== null)
      assert.ok(Object.hasOwn(config.hooks, 'request'))
      assert.strictEqual(typeof config.hooks.request, 'function')
      assert.strictEqual(config.queryStringObfuscation, true)
    })

    it('should use the shared config if set', () => {
      const config = web.normalizeConfig({
        headers: ['test'],
        validateStatus: code => false,
        hooks: {
          request: () => 'test',
        },
      })

      assert.deepStrictEqual(config.headers, [['test', undefined]])
      assert.strictEqual(config.validateStatus(200), false)
      assert.ok(Object.hasOwn(config, 'hooks'))
      assert.strictEqual(config.hooks.request(), 'test')
    })

    describe('queryStringObfuscation', () => {
      it('should keep booleans as is', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: false,
        })

        assert.strictEqual(config.queryStringObfuscation, false)
      })

      it('should change to false when passed empty string', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: '',
        })

        assert.strictEqual(config.queryStringObfuscation, false)
      })

      it('should change to true when passed ".*"', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: '.*',
        })

        assert.strictEqual(config.queryStringObfuscation, true)
      })

      it('should convert to regex when passed valid string', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: 'a*',
        })

        assert.ok('queryStringObfuscation' in config)
        assert.deepStrictEqual(config.queryStringObfuscation, /a*/gi)
      })

      it('should default to true when passed a bad regex', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: '(?)',
        })

        assert.strictEqual(config.queryStringObfuscation, true)
      })
    })

    describe('clientIpEnabled', () => {
      it('leaves extractIp undefined when clientIpEnabled is not set', () => {
        const config = web.normalizeConfig({})

        assert.strictEqual(config.extractIp, undefined)
      })

      it('resolves extractIp to the ip_extractor implementation when clientIpEnabled is true', () => {
        const config = web.normalizeConfig({ clientIpEnabled: true })
        const { extractIp } = require('../../../src/plugins/util/ip_extractor')

        assert.strictEqual(config.extractIp, extractIp)
      })
    })
  })

  describe('startSpan client IP extraction', () => {
    it('tags the span with the extracted client IP when clientIpEnabled is set', () => {
      const config = web.normalizeConfig({ clientIpEnabled: true })
      req.headers['x-forwarded-for'] = '8.8.8.8'

      const span = web.startSpan(tracer, config, req, res, 'test.request')

      assert.strictEqual(span.context().getTag(HTTP_CLIENT_IP), '8.8.8.8')
    })

    it('leaves the client IP tag unset when clientIpEnabled is not set', () => {
      const config = web.normalizeConfig({})
      req.headers['x-forwarded-for'] = '8.8.8.8'

      const span = web.startSpan(tracer, config, req, res, 'test.request')

      assert.strictEqual(span.context().hasTag(HTTP_CLIENT_IP), false)
    })

    // Regression for the per-plugin scoping fix: a later normalizeConfig call
    // for a different plugin must not disable IP extraction on the earlier
    // plugin's config. Used to fail because extractIp lived on the module.
    it('keeps extraction enabled on the first config after a second plugin normalizes without clientIpEnabled',
      () => {
        const enabledConfig = web.normalizeConfig({ clientIpEnabled: true })
        web.normalizeConfig({})
        req.headers['x-forwarded-for'] = '8.8.8.8'

        const span = web.startSpan(tracer, enabledConfig, req, res, 'test.request')

        assert.strictEqual(span.context().getTag(HTTP_CLIENT_IP), '8.8.8.8')
      })
  })

  describe('root', () => {
    it('should return null when not yet instrumented', () => {
      assert.strictEqual(web.root(req), null)
    })
  })

  describe('active', () => {
    it('should return null when not yet instrumented', () => {
      assert.strictEqual(web.active(req), null)
    })
  })

  describe('addError', () => {
    beforeEach(() => {
      span = tracer.startSpan('test.request')
      tags = span.context().getTags()

      web.patch(req)
      const context = web.getContext(req)
      context.span = span
      context.req = req
      context.res = res
      context.config = config
    })

    it('should add an error to the request span', () => {
      const error = new Error('boom')

      web.addError(req, error)
      web.addStatusError(req, 500)

      assert.strictEqual(tags[ERROR], error)
    })

    it('should override an existing error', () => {
      const error = new Error('boom')

      web.addError(req, new Error('prrr'))
      web.addError(req, error)
      web.addStatusError(req, 500)

      assert.strictEqual(tags[ERROR], error)
    })
  })

  describe('addStatusError', () => {
    beforeEach(() => {
      span = tracer.startSpan('test.request')
      tags = span.context().getTags()

      web.patch(req)
      const context = web.getContext(req)
      context.span = span
      context.req = req
      context.res = res
      context.config = config
    })

    it('should flag the request as an error', () => {
      web.addStatusError(req, 500)

      assert.strictEqual(tags[ERROR], true)
    })

    it('should only flag requests as an error for configured status codes', () => {
      config.validateStatus = () => true

      web.addStatusError(req, 500)

      assert.ok(!(ERROR in tags))
    })
  })

  describe('setConfig service', () => {
    const SVC_SRC_KEY = '_dd.svc_src'

    beforeEach(() => {
      req.url = '/'
      web.plugin = null
    })

    it('writes service.name from config.service onto the span', () => {
      const customConfig = web.normalizeConfig({ service: 'integration-svc' })

      const span = web.startSpan(tracer, customConfig, req, res, 'test.request')
      const spanContext = span.context()

      assert.strictEqual(spanContext.getTag('service.name'), 'integration-svc')
    })

    it('stamps the integration claim so a user override is flagged manual at finish', () => {
      const customConfig = web.normalizeConfig({ service: 'integration-svc' })

      const span = web.startSpan(tracer, customConfig, req, res, 'test.request')
      const spanContext = span.context()

      span.setTag('service.name', 'user-override')
      span.finish()

      assert.strictEqual(spanContext.getTag('service.name'), 'user-override')
      assert.strictEqual(spanContext.getTag(SVC_SRC_KEY), 'm')
    })

    it('does not stamp manual when the user does not override the integration service', () => {
      const customConfig = web.normalizeConfig({ service: 'integration-svc' })

      const span = web.startSpan(tracer, customConfig, req, res, 'test.request')
      const spanContext = span.context()

      span.finish()

      assert.strictEqual(spanContext.getTag('service.name'), 'integration-svc')
      assert.strictEqual(spanContext.getTag(SVC_SRC_KEY), undefined)
    })
  })

  describe('allowlistFilter', () => {
    beforeEach(() => {
      config = { allowlist: ['/_okay'] }
      config = web.normalizeConfig(config)
    })

    it('should not filter the url', () => {
      const filtered = config.filter('/_okay')
      assert.strictEqual(filtered, true)
    })

    it('should filter the url', () => {
      const filtered = config.filter('/_notokay')
      assert.strictEqual(filtered, false)
    })
  })

  describe('whitelistFilter', () => {
    beforeEach(() => {
      config = { whitelist: ['/_okay'] }
      config = web.normalizeConfig(config)
    })

    it('should not filter the url', () => {
      const filtered = config.filter('/_okay')
      assert.strictEqual(filtered, true)
    })

    it('should filter the url', () => {
      const filtered = config.filter('/_notokay')
      assert.strictEqual(filtered, false)
    })
  })

  describe('blocklistFilter', () => {
    beforeEach(() => {
      config = { blocklist: ['/_notokay'] }
      config = web.normalizeConfig(config)
    })

    it('should not filter the url', () => {
      const filtered = config.filter('/_okay')
      assert.strictEqual(filtered, true)
    })

    it('should filter the url', () => {
      const filtered = config.filter('/_notokay')
      assert.strictEqual(filtered, false)
    })
  })

  describe('blacklistFilter', () => {
    beforeEach(() => {
      config = { blacklist: ['/_notokay'] }
      config = web.normalizeConfig(config)
    })

    it('should not filter the url', () => {
      const filtered = config.filter('/_okay')
      assert.strictEqual(filtered, true)
    })

    it('should filter the url', () => {
      const filtered = config.filter('/_notokay')
      assert.strictEqual(filtered, false)
    })
  })

  describe('http.endpoint tagging', () => {
    beforeEach(() => {
      span = tracer.startSpan('test.request')
      tags = span.context().getTags()

      req.url = '/'

      web.patch(req)
      const context = web.getContext(req)
      context.span = span
      context.req = req
      context.res = res
      context.config = config
    })

    it('should derive http.endpoint when no framework route is available', () => {
      config = web.normalizeConfig({ resourceRenamingEnabled: true })
      req.method = 'GET'
      req.url = '/api/orders/12345/items?foo=bar'

      const context = web.getContext(req)
      context.config = config

      web.finishAll(context)

      assert.ok(!Object.hasOwn(tags, HTTP_ROUTE))
      assert.strictEqual(tags[HTTP_ENDPOINT], '/api/orders/{param:int}/items')
    })

    it('should not set http.endpoint when resource renaming is disabled', () => {
      config = web.normalizeConfig({ resourceRenamingEnabled: false })
      req.method = 'GET'
      req.url = '/api/orders/12345/items'

      const context = web.getContext(req)
      context.config = config

      web.finishAll(context)

      assert.ok(!Object.hasOwn(tags, HTTP_ENDPOINT))
      assert.ok(!Object.hasOwn(tags, HTTP_ROUTE))
      assert.strictEqual(tags[RESOURCE_NAME], 'GET')
    })
  })

  describe('security testing headers', () => {
    const SCAN_TAG = 'http.request.headers.x-datadog-endpoint-scan'
    const TEST_TAG = 'http.request.headers.x-datadog-security-test'

    beforeEach(() => {
      span = tracer.startSpan('test.request')
      tags = span.context().getTags()

      req.url = '/'

      web.patch(req)
      const context = web.getContext(req)
      context.span = span
      context.req = req
      context.res = res
      context.config = config
    })

    it('should tag x-datadog-endpoint-scan and x-datadog-security-test on the entry span', () => {
      req.headers['x-datadog-endpoint-scan'] = 'scan-uuid-1'
      req.headers['x-datadog-security-test'] = 'test-uuid-2'
      req.headers['x-other-header'] = 'ignored'

      web.finishAll(web.getContext(req))

      assert.deepStrictEqual(
        { scan: tags[SCAN_TAG], test: tags[TEST_TAG], other: tags['http.request.headers.x-other-header'] },
        { scan: 'scan-uuid-1', test: 'test-uuid-2', other: undefined }
      )
    })

    it('should not set tags when the headers are not in the request', () => {
      web.finishAll(web.getContext(req))

      assert.deepStrictEqual(
        { scan: tags[SCAN_TAG], test: tags[TEST_TAG] },
        { scan: undefined, test: undefined }
      )
    })

    it('should tag the headers even when DD_TRACE_HEADER_TAGS is set to unrelated headers', () => {
      config = web.normalizeConfig({ headers: ['x-other-header'] })
      const context = web.getContext(req)
      context.config = config

      req.headers['x-datadog-endpoint-scan'] = 'scan-uuid'
      req.headers['x-datadog-security-test'] = 'test-uuid'
      req.headers['x-other-header'] = 'other'

      web.finishAll(context)

      assert.deepStrictEqual(
        {
          scan: tags[SCAN_TAG],
          test: tags[TEST_TAG],
          other: tags['http.request.headers.x-other-header'],
        },
        { scan: 'scan-uuid', test: 'test-uuid', other: 'other' }
      )
    })

    it('should tag the headers even when their value is an empty string', () => {
      req.headers['x-datadog-endpoint-scan'] = ''
      req.headers['x-datadog-security-test'] = 'ok'

      web.finishAll(web.getContext(req))

      assert.deepStrictEqual(
        { scan: tags[SCAN_TAG], test: tags[TEST_TAG] },
        { scan: '', test: 'ok' }
      )
    })
  })

  describe('setRouteOrEndpointTag http.route fast path', () => {
    let context

    beforeEach(() => {
      span = tracer.startSpan('test.request')
      tags = span.context().getTags()

      req.url = '/'

      web.patch(req)
      context = web.getContext(req)
      context.span = span
      context.req = req
      context.res = res
      context.config = config
    })

    it('leaves http.route unset when no segments were collected', () => {
      context.paths = []

      web.setRouteOrEndpointTag(req)

      assert.ok(!Object.hasOwn(tags, HTTP_ROUTE))
    })

    it('uses the single segment directly without entering Array.join', () => {
      context.paths = ['/users/:id']

      web.setRouteOrEndpointTag(req)

      assert.strictEqual(tags[HTTP_ROUTE], '/users/:id')
    })

    it('leaves http.route unset for a single empty-string segment', () => {
      context.paths = ['']

      web.setRouteOrEndpointTag(req)

      assert.ok(!Object.hasOwn(tags, HTTP_ROUTE))
    })

    it('joins two segments byte-identical to the legacy join shape', () => {
      context.paths = ['/api', '/users/:id']

      web.setRouteOrEndpointTag(req)

      assert.strictEqual(tags[HTTP_ROUTE], '/api/users/:id')
    })

    it('joins three segments byte-identical to the legacy join shape', () => {
      context.paths = ['/api', '/users', '/:id/items']

      web.setRouteOrEndpointTag(req)

      assert.strictEqual(tags[HTTP_ROUTE], '/api/users/:id/items')
    })
  })

  describe('route resolved after the AppSec pre-finish endpoint fallback', () => {
    let context

    beforeEach(() => {
      config = web.normalizeConfig({ resourceRenamingEnabled: true })
      req.method = 'GET'
      req.url = '/users/123'

      span = web.startSpan(tracer, config, req, res, 'test.request')
      tags = span.context().getTags()
      context = web.getContext(req)
    })

    it('keeps http.route when the framework resolves the route after http.endpoint was stamped', () => {
      // AppSec's incomingHttpRequestEnd hook stamps http.endpoint while the
      // framework route is still unresolved.
      web.setRouteOrEndpointTag(req)
      assert.ok(Object.hasOwn(tags, HTTP_ENDPOINT))
      assert.ok(!Object.hasOwn(tags, HTTP_ROUTE))

      // The framework resolves the route between the pre-finish hook and finish.
      web.setRoute(req, '/users/:id')

      web.finishAll(context)

      assert.strictEqual(tags[HTTP_ROUTE], '/users/:id')
      assert.strictEqual(tags[RESOURCE_NAME], 'GET /users/:id')
    })

    it('uses http.route alone when the route resolves before the pre-finish hook', () => {
      web.setRoute(req, '/users/:id')

      web.setRouteOrEndpointTag(req)
      assert.ok(!Object.hasOwn(tags, HTTP_ENDPOINT))

      web.finishAll(context)

      assert.strictEqual(tags[HTTP_ROUTE], '/users/:id')
      assert.ok(!Object.hasOwn(tags, HTTP_ENDPOINT))
      assert.strictEqual(tags[RESOURCE_NAME], 'GET /users/:id')
    })

    it('keeps the http.endpoint fallback when no route ever resolves', () => {
      web.setRouteOrEndpointTag(req)
      const endpoint = tags[HTTP_ENDPOINT]
      assert.ok(endpoint)

      web.finishAll(context)

      assert.strictEqual(tags[HTTP_ENDPOINT], endpoint)
      assert.ok(!Object.hasOwn(tags, HTTP_ROUTE))
      assert.strictEqual(tags[RESOURCE_NAME], 'GET')
    })
  })

  describe('configured header tagging across the request lifecycle', () => {
    const USER_AGENT_TAG = `${HTTP_REQUEST_HEADERS}.user-agent`
    const SERVER_TAG = `${HTTP_RESPONSE_HEADERS}.server`

    beforeEach(() => {
      req.url = '/users'
      req.headers['user-agent'] = 'test'
    })

    it('honours headers added to the plugin config after startSpan', () => {
      const httpConfig = web.normalizeConfig({})
      const frameworkConfig = web.normalizeConfig({ headers: ['user-agent', 'server'] })

      web.startSpan(tracer, httpConfig, req, res, 'test.request')
      span = web.root(req)
      tags = span.context().getTags()

      assert.ok(Object.hasOwn(tags, 'http.url'))
      assert.ok(!Object.hasOwn(tags, USER_AGENT_TAG))

      web.setFramework(req, 'test-framework', frameworkConfig)

      web.finishAll(web.getContext(req))

      assert.strictEqual(tags[USER_AGENT_TAG], 'test')
      assert.strictEqual(tags[SERVER_TAG], 'test')
    })

    it('still tags headers when the http-side config already lists them', () => {
      const httpConfig = web.normalizeConfig({ headers: ['user-agent'] })

      web.startSpan(tracer, httpConfig, req, res, 'test.request')
      span = web.root(req)
      tags = span.context().getTags()

      web.finishAll(web.getContext(req))

      assert.strictEqual(tags[USER_AGENT_TAG], 'test')
    })
  })

  describe('normalizeConfig clientIpEnabled', () => {
    beforeEach(() => {
      req.url = '/'
      req.headers['x-forwarded-for'] = '203.0.113.5'
    })

    it('does not tag http.client_ip when clientIpEnabled is not set', () => {
      const httpConfig = web.normalizeConfig({})

      web.startSpan(tracer, httpConfig, req, res, 'test.request')
      span = web.root(req)

      web.finishAll(web.getContext(req))

      assert.ok(!span.context().hasTag(HTTP_CLIENT_IP))
    })

    it('tags http.client_ip when clientIpEnabled is true', () => {
      const httpConfig = web.normalizeConfig({ clientIpEnabled: true })

      web.startSpan(tracer, httpConfig, req, res, 'test.request')
      span = web.root(req)

      web.finishAll(web.getContext(req))

      assert.strictEqual(span.context().getTag(HTTP_CLIENT_IP), '203.0.113.5')
    })
  })

  describe('wrapWriteHead', () => {
    const ALLOW_HEADERS = 'access-control-allow-headers'
    const ALLOW_ORIGIN = 'access-control-allow-origin'
    let context

    beforeEach(() => {
      span = tracer.startSpan('test.request')

      web.patch(req)
      context = web.getContext(req)
      context.span = span
      context.req = req
      context.res = res
      context.config = config
    })

    it('does not touch CORS headers for non-OPTIONS requests', () => {
      req.method = 'GET'
      req.headers.origin = 'https://example.com'
      req.headers['access-control-request-headers'] = 'x-datadog-trace-id'
      res.getHeaders.returns({ [ALLOW_ORIGIN]: '*' })

      const wrapped = web.wrapWriteHead(context)
      wrapped.call(res, 200)

      assert.ok(res.setHeader.notCalled)
    })

    it('skips allow-header tagging on OPTIONS when the origin is not allowed', () => {
      req.method = 'OPTIONS'
      req.headers.origin = 'https://evil.example.com'
      req.headers['access-control-request-headers'] = 'x-datadog-trace-id'
      res.getHeaders.returns({ [ALLOW_ORIGIN]: 'https://good.example.com' })

      const wrapped = web.wrapWriteHead(context)
      wrapped.call(res, 200)

      assert.ok(res.setHeader.notCalled)
    })

    it('merges datadog allow-headers on OPTIONS when allow-origin is *', () => {
      req.method = 'OPTIONS'
      req.headers.origin = 'https://example.com'
      req.headers['access-control-request-headers'] =
        'x-datadog-trace-id, x-datadog-parent-id, x-other'
      res.getHeaders.returns({ [ALLOW_ORIGIN]: '*' })

      const wrapped = web.wrapWriteHead(context)
      wrapped.call(res, 200)

      assert.ok(res.setHeader.calledOnce)
      assert.deepStrictEqual(
        res.setHeader.firstCall.args,
        [ALLOW_HEADERS, 'x-datadog-parent-id,x-datadog-trace-id']
      )
    })

    it('honours headers passed as the second writeHead argument', () => {
      req.method = 'OPTIONS'
      req.headers.origin = 'https://example.com'
      req.headers['access-control-request-headers'] = 'x-datadog-trace-id'
      res.getHeaders.returns({})

      const wrapped = web.wrapWriteHead(context)
      wrapped.call(res, 200, { [ALLOW_ORIGIN]: 'https://example.com' })

      assert.ok(res.setHeader.calledOnce)
      assert.deepStrictEqual(
        res.setHeader.firstCall.args,
        [ALLOW_HEADERS, 'x-datadog-trace-id']
      )
    })

    it('honours headers passed as the third writeHead argument with a status message', () => {
      req.method = 'OPTIONS'
      req.headers.origin = 'https://example.com'
      req.headers['access-control-request-headers'] = 'x-datadog-trace-id'
      res.getHeaders.returns({})

      const wrapped = web.wrapWriteHead(context)
      wrapped.call(res, 200, 'OK', { [ALLOW_ORIGIN]: '*' })

      assert.ok(res.setHeader.calledOnce)
      assert.deepStrictEqual(
        res.setHeader.firstCall.args,
        [ALLOW_HEADERS, 'x-datadog-trace-id']
      )
    })

    it('treats lowercase req.method "options" as OPTIONS', () => {
      req.method = 'options'
      req.headers.origin = 'https://example.com'
      req.headers['access-control-request-headers'] = 'x-datadog-trace-id'
      res.getHeaders.returns({ [ALLOW_ORIGIN]: '*' })

      const wrapped = web.wrapWriteHead(context)
      wrapped.call(res, 200)

      assert.ok(res.setHeader.calledOnce)
      assert.deepStrictEqual(
        res.setHeader.firstCall.args,
        [ALLOW_HEADERS, 'x-datadog-trace-id']
      )
    })

    it('preserves existing allow-headers and de-duplicates datadog additions', () => {
      req.method = 'OPTIONS'
      req.headers.origin = 'https://example.com'
      req.headers['access-control-request-headers'] = 'x-datadog-trace-id, x-datadog-trace-id'
      res.getHeaders.returns({
        [ALLOW_ORIGIN]: '*',
        [ALLOW_HEADERS]: 'content-type, x-datadog-trace-id',
      })

      const wrapped = web.wrapWriteHead(context)
      wrapped.call(res, 200)

      assert.ok(res.setHeader.calledOnce)
      assert.deepStrictEqual(
        res.setHeader.firstCall.args,
        [ALLOW_HEADERS, 'content-type,x-datadog-trace-id']
      )
    })

    it('leaves allow-headers untouched when no datadog header was requested', () => {
      req.method = 'OPTIONS'
      req.headers.origin = 'https://example.com'
      req.headers['access-control-request-headers'] = 'content-type, x-other'
      res.getHeaders.returns({ [ALLOW_ORIGIN]: '*' })

      const wrapped = web.wrapWriteHead(context)
      wrapped.call(res, 200)

      assert.ok(res.setHeader.notCalled)
    })

    it('delegates to the original writeHead with the same arguments', () => {
      req.method = 'OPTIONS'
      req.headers.origin = 'https://example.com'
      res.getHeaders.returns({ [ALLOW_ORIGIN]: '*' })
      res.writeHead = sinon.spy()

      const wrapped = web.wrapWriteHead(context)
      wrapped.call(res, 204, 'No Content', { 'x-test': '1' })

      assert.ok(res.writeHead.calledOnce)
      assert.deepStrictEqual(
        res.writeHead.firstCall.args,
        [204, 'No Content', { 'x-test': '1' }]
      )
    })
  })
})
