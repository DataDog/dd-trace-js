'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

describe('AppSec Lambda handler', () => {
  let lambda
  let waf
  let Reporter
  let keepTrace
  let log
  let addresses

  const fakeSpan = () => {
    const tags = {}
    return {
      addTags: sinon.stub().callsFake((obj) => Object.assign(tags, obj)),
      setTag: sinon.stub().callsFake((k, v) => { tags[k] = v }),
      context: sinon.stub().returns({ _tags: tags }),
      _tags: tags,
    }
  }

  beforeEach(() => {
    waf = {
      run: sinon.stub(),
      disposeContext: sinon.stub(),
    }

    Reporter = {
      finishRequest: sinon.stub(),
    }

    keepTrace = sinon.stub()

    log = {
      warn: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
    }

    addresses = require('../../src/appsec/addresses')

    lambda = proxyquire('../../src/appsec/lambda', {
      '../log': log,
      './waf': waf,
      './reporter': Reporter,
      '../priority_sampler': { keepTrace },
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('onLambdaStartInvocation', () => {
    it('should warn and return when no span is provided', () => {
      lambda.onLambdaStartInvocation({})

      sinon.assert.calledOnce(log.warn)
      sinon.assert.notCalled(waf.run)
    })

    it('should set appsec enabled tags on the span', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({
        span,
        headers: { host: 'example.com' },
        method: 'GET',
        path: '/test',
      })

      assert.equal(span._tags['_dd.appsec.enabled'], 1)
    })

    it('should set HTTP_CLIENT_IP tag when clientIp is provided', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({
        span,
        headers: {},
        method: 'GET',
        path: '/',
        clientIp: '1.2.3.4',
      })

      assert.equal(span._tags['http.client_ip'], '1.2.3.4')
    })

    it('should store the invocation key on the span', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({
        span,
        headers: {},
        method: 'GET',
        path: '/',
      })

      assert.ok(span._lambdaAppsecKey)
      assert.equal(typeof span._lambdaAppsecKey, 'object')
    })

    it('should call waf.run with mapped addresses', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({
        span,
        headers: { host: 'example.com' },
        method: 'POST',
        path: '/api/test',
        query: { foo: 'bar' },
        body: { key: 'value' },
        clientIp: '10.0.0.1',
        pathParams: { id: '123' },
        cookies: { session: 'abc' },
      })

      sinon.assert.calledOnce(waf.run)

      const [data, key, raspRule, rootSpan] = waf.run.firstCall.args
      assert.deepStrictEqual(data.persistent, {
        [addresses.HTTP_INCOMING_URL]: '/api/test',
        [addresses.HTTP_INCOMING_METHOD]: 'POST',
        [addresses.HTTP_INCOMING_HEADERS]: { host: 'example.com' },
        [addresses.HTTP_CLIENT_IP]: '10.0.0.1',
        [addresses.HTTP_INCOMING_QUERY]: { foo: 'bar' },
        [addresses.HTTP_INCOMING_BODY]: { key: 'value' },
        [addresses.HTTP_INCOMING_PARAMS]: { id: '123' },
        [addresses.HTTP_INCOMING_COOKIES]: { session: 'abc' },
      })
      assert.equal(key, span._lambdaAppsecKey)
      assert.equal(raspRule, undefined)
      assert.equal(rootSpan, span)
    })

    it('should not include undefined optional fields in WAF addresses', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({
        span,
        headers: { host: 'example.com' },
        method: 'GET',
        path: '/',
      })

      sinon.assert.calledOnce(waf.run)
      const persistent = waf.run.firstCall.args[0].persistent
      assert.ok(!(addresses.HTTP_INCOMING_QUERY in persistent))
      assert.ok(!(addresses.HTTP_INCOMING_BODY in persistent))
      assert.ok(!(addresses.HTTP_INCOMING_PARAMS in persistent))
      assert.ok(!(addresses.HTTP_INCOMING_COOKIES in persistent))
      assert.ok(!(addresses.HTTP_CLIENT_IP in persistent))
    })

    it('should catch errors and log them', () => {
      const span = fakeSpan()
      waf.run.throws(new Error('boom'))

      lambda.onLambdaStartInvocation({
        span,
        headers: {},
        method: 'GET',
        path: '/',
      })

      sinon.assert.calledOnce(log.error)
    })
  })

  describe('onLambdaEndInvocation', () => {
    it('should warn and return when no span is provided', () => {
      lambda.onLambdaEndInvocation({})

      sinon.assert.calledOnce(log.warn)
      sinon.assert.notCalled(waf.run)
    })

    it('should return silently when no invocation key is found on span', () => {
      const span = fakeSpan()

      lambda.onLambdaEndInvocation({ span })

      sinon.assert.notCalled(waf.run)
      sinon.assert.notCalled(waf.disposeContext)
    })

    it('should run WAF with response addresses and dispose context', () => {
      const span = fakeSpan()
      span._lambdaAppsecKey = {}

      lambda.onLambdaEndInvocation({
        span,
        statusCode: '200',
        responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'foo=bar' },
      })

      sinon.assert.calledOnce(waf.run)
      const persistent = waf.run.firstCall.args[0].persistent
      assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_CODE], '200')
      assert.deepStrictEqual(persistent[addresses.HTTP_INCOMING_RESPONSE_HEADERS], {
        'content-type': 'application/json',
      })
      assert.ok(!('set-cookie' in persistent[addresses.HTTP_INCOMING_RESPONSE_HEADERS]))

      sinon.assert.calledOnce(waf.disposeContext)
      sinon.assert.calledOnce(Reporter.finishRequest)
    })

    it('should skip WAF run when no response data', () => {
      const span = fakeSpan()
      span._lambdaAppsecKey = {}

      lambda.onLambdaEndInvocation({ span })

      sinon.assert.notCalled(waf.run)
      sinon.assert.calledOnce(waf.disposeContext)
      sinon.assert.calledOnce(Reporter.finishRequest)
    })

    it('should clean up _lambdaAppsecKey after processing', () => {
      const span = fakeSpan()
      span._lambdaAppsecKey = {}

      lambda.onLambdaEndInvocation({
        span,
        statusCode: '200',
      })

      assert.equal(span._lambdaAppsecKey, undefined)
    })

    it('should pass the span as rootSpan to Reporter.finishRequest', () => {
      const span = fakeSpan()
      span._lambdaAppsecKey = {}

      lambda.onLambdaEndInvocation({ span, statusCode: '200' })

      sinon.assert.calledOnce(Reporter.finishRequest)
      const args = Reporter.finishRequest.firstCall.args
      assert.equal(args[4], span)
    })

    it('should catch errors and log them', () => {
      const span = fakeSpan()
      span._lambdaAppsecKey = {}
      waf.disposeContext.throws(new Error('boom'))

      lambda.onLambdaEndInvocation({ span, statusCode: '200' })

      sinon.assert.calledOnce(log.error)
    })

    it('should call Reporter.finishRequest with null req/res and the span as rootSpan', () => {
      const span = fakeSpan()
      span._lambdaAppsecKey = {}

      lambda.onLambdaEndInvocation({ span, statusCode: '200' })

      sinon.assert.calledOnce(Reporter.finishRequest)
      const [req, res, storedHeaders, body, rootSpan] = Reporter.finishRequest.firstCall.args
      assert.equal(req, null)
      assert.equal(res, null)
      assert.deepStrictEqual(storedHeaders, {})
      assert.equal(body, undefined)
      assert.equal(rootSpan, span)
    })

    it('should use the same invocationKey for WAF run and dispose across start and end', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({
        span,
        headers: { host: 'example.com' },
        method: 'GET',
        path: '/',
      })

      const invocationKey = span._lambdaAppsecKey

      lambda.onLambdaEndInvocation({ span, statusCode: '200' })

      const startKey = waf.run.firstCall.args[1]
      const endKey = waf.run.secondCall.args[1]
      const disposeKey = waf.disposeContext.firstCall.args[0]

      assert.equal(startKey, invocationKey)
      assert.equal(endKey, invocationKey)
      assert.equal(disposeKey, invocationKey)
    })
  })
})

// ─── WAF path safety: contract enforcement for non-HTTP req ───────────────────
//
// In Lambda, `req` in the WAF execution path is a plain context key ({}) with
// no HTTP properties (no socket, headers, body, etc.). The tests below exercise
// the real WAFContextWrapper → Reporter chain with such an object to verify that
// no unguarded req property access exists.
//
// A Proxy-based `strictNonHttpReq` is used as the req object. It allows access
// to properties that have been audited as safe (they return undefined and all
// call-sites guard against it), and throws on any NEW property access. This
// forces developers to explicitly acknowledge and guard new req usages.
// ──────────────────────────────────────────────────────────────────────────────

describe('WAF path safety with non-HTTP req', () => {
  let RealReporter
  let WAFContextWrapper
  let web
  let telemetry

  // Properties on req that are known to be accessed in the WAF/reporter path
  // and have been verified safe for non-HTTP objects (all return undefined).
  // If you need to access a new req property, add it here AND ensure the
  // call-site guards against undefined (e.g. req?.prop, if (prop) ...).
  const AUDITED_REQ_PROPERTIES = new Set([
    'socket', // reportAttack: guarded with req?.socket
    'body', // reportAttack: only reached when config.raspBodyCollection && isRaspAttack; undefined is safe
  ])

  function makeStrictNonHttpReq () {
    return new Proxy(Object.create(null), {
      get (_target, prop) {
        if (typeof prop === 'symbol') return undefined
        if (AUDITED_REQ_PROPERTIES.has(prop)) return undefined
        throw new Error(
          `Unguarded access to req.${String(prop)} in WAF path — ` +
          'req may not be an HTTP request (e.g. Lambda invocation key). ' +
          'Guard the access or add the property to AUDITED_REQ_PROPERTIES in lambda.spec.js.'
        )
      },
    })
  }

  const fakeSpan = () => {
    const tags = {}
    return {
      addTags: sinon.stub().callsFake((obj) => Object.assign(tags, obj)),
      setTag: sinon.stub().callsFake((k, v) => { tags[k] = v }),
      context: sinon.stub().returns({ _tags: tags }),
      keep: sinon.stub(),
      _tags: tags,
    }
  }

  beforeEach(() => {
    web = {
      root: sinon.stub(),
      getContext: sinon.stub(),
    }

    telemetry = {
      incrementWafInitMetric: sinon.stub(),
      incrementWafConfigErrorsMetric: sinon.stub(),
      incrementWafUpdatesMetric: sinon.stub(),
      incrementWafRequestsMetric: sinon.stub(),
      updateWafRequestsMetricTags: sinon.stub(),
      updateRaspRequestsMetricTags: sinon.stub(),
      updateRaspRuleSkippedMetricTags: sinon.stub(),
      updateRateLimitedMetric: sinon.stub(),
      getRequestMetrics: sinon.stub(),
    }

    RealReporter = proxyquire('../../src/appsec/reporter', {
      '../plugins/util/web': web,
      './telemetry': telemetry,
    })

    WAFContextWrapper = proxyquire('../../src/appsec/waf/waf_context_wrapper', {
      '../reporter': RealReporter,
      '../../log': { warn: sinon.stub(), error: sinon.stub() },
      '../blocking': { getBlockingAction: () => undefined },
      '../channels': { wafRunFinished: { hasSubscribers: false } },
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  it('should complete WAF run with attack result without accessing non-HTTP req properties', () => {
    const req = makeStrictNonHttpReq()
    const span = fakeSpan()

    const mockDdwafContext = {
      disposed: false,
      run: sinon.stub().returns({
        events: [{ rule: { id: 'ua0-600-55x', tags: { type: 'security_scanner' } } }],
        actions: {},
        duration: 100,
        timeout: false,
        metrics: {},
      }),
    }

    const knownAddresses = new Set([
      'server.request.headers.no_cookies',
      'server.request.uri.raw',
      'server.request.method',
    ])

    const ctx = new WAFContextWrapper(mockDdwafContext, 5000, '1.18.0', '1.13.3', knownAddresses)

    ctx.run(
      { persistent: { 'server.request.headers.no_cookies': { host: 'example.com' } } },
      undefined,
      req,
      span
    )

    assert.equal(span._tags['appsec.event'], 'true')
    assert.ok(span._tags['_dd.appsec.json'])
    assert.equal(span._tags['network.client.ip'], undefined)
  })

  it('should complete WAF run without attack without accessing non-HTTP req properties', () => {
    const req = makeStrictNonHttpReq()
    const span = fakeSpan()

    const mockDdwafContext = {
      disposed: false,
      run: sinon.stub().returns({
        events: [],
        actions: {},
        duration: 50,
        timeout: false,
        metrics: {},
      }),
    }

    const knownAddresses = new Set(['server.request.uri.raw'])
    const ctx = new WAFContextWrapper(mockDdwafContext, 5000, '1.18.0', '1.13.3', knownAddresses)

    ctx.run(
      { persistent: { 'server.request.uri.raw': '/test' } },
      undefined,
      req,
      span
    )

    sinon.assert.calledOnce(telemetry.updateWafRequestsMetricTags)
    assert.equal(span._tags['appsec.event'], undefined)
  })

  it('should complete WAF run with attributes without accessing non-HTTP req properties', () => {
    const req = makeStrictNonHttpReq()
    const span = fakeSpan()

    const mockDdwafContext = {
      disposed: false,
      run: sinon.stub().returns({
        events: [],
        actions: {},
        duration: 50,
        timeout: false,
        metrics: {},
        attributes: { '_dd.appsec.s.req.body': [{ key: [8] }] },
      }),
    }

    const knownAddresses = new Set(['server.request.uri.raw'])
    const ctx = new WAFContextWrapper(mockDdwafContext, 5000, '1.18.0', '1.13.3', knownAddresses)

    ctx.run(
      { persistent: { 'server.request.uri.raw': '/test' } },
      undefined,
      req,
      span
    )

    assert.ok(span._tags['_dd.appsec.s.req.body'])
  })

  it('should complete finishRequest with null req without crash', () => {
    const span = fakeSpan()

    RealReporter.finishRequest(null, null, {}, undefined, span)
  })

  it('should flush metricsQueue in finishRequest with null req (Lambda production path)', () => {
    const span = fakeSpan()

    RealReporter.metricsQueue.set('_dd.appsec.waf.duration', 100)

    RealReporter.finishRequest(null, null, {}, undefined, span)

    assert.equal(span._tags['_dd.appsec.waf.duration'], 100)
    assert.equal(RealReporter.metricsQueue.size, 0)
  })

  it('should use Proxy as a valid WeakMap key for telemetry and WAF contexts', () => {
    const req = makeStrictNonHttpReq()
    const weakMap = new WeakMap()

    weakMap.set(req, { duration: 42 })
    assert.deepStrictEqual(weakMap.get(req), { duration: 42 })

    weakMap.delete(req)
    assert.equal(weakMap.get(req), undefined)
  })
})
