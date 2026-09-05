'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { AUTO_REJECT, USER_REJECT } = require('../../../../ext/priority')

describe('AppSec Lambda handler', () => {
  let lambda
  let waf
  let Reporter
  let keepTrace
  let log
  let addresses

  const fakeSpan = (sampling) => {
    const tags = {}
    const spanContext = {
      _sampling: sampling,
      getTag (key) { return tags[key] },
    }
    return {
      addTags: sinon.stub().callsFake((obj) => Object.assign(tags, obj)),
      setTag: sinon.stub().callsFake((k, v) => { tags[k] = v }),
      context: sinon.stub().returns(spanContext),
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

      assert.equal(span.context().getTag('_dd.appsec.enabled'), 1)
      assert.equal(span.context().getTag('_dd.runtime_family'), 'nodejs')
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

      assert.equal(span.context().getTag('http.client_ip'), '1.2.3.4')
    })

    it('should call waf.run with mapped addresses, a synthetic req key, and the span as rootSpan', () => {
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
      assert.deepStrictEqual(key, { headers: { host: 'example.com' } })
      assert.notEqual(key, span)
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

    it('should return silently when start-invocation was not called for this span', () => {
      const span = fakeSpan()

      lambda.onLambdaEndInvocation({ span })

      sinon.assert.notCalled(waf.run)
      sinon.assert.notCalled(waf.disposeContext)
    })

    it('should run WAF with response addresses and dispose context', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({ span, headers: {}, method: 'GET', path: '/' })
      waf.run.reset()

      lambda.onLambdaEndInvocation({
        span,
        statusCode: '200',
        responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'foo=bar' },
      })

      sinon.assert.calledOnce(waf.run)
      const [data, key] = waf.run.firstCall.args
      assert.equal(data.persistent[addresses.HTTP_INCOMING_RESPONSE_CODE], '200')
      assert.deepStrictEqual(data.persistent[addresses.HTTP_INCOMING_RESPONSE_HEADERS], {
        'content-type': 'application/json',
      })
      assert.ok(!('set-cookie' in data.persistent[addresses.HTTP_INCOMING_RESPONSE_HEADERS]))
      assert.deepStrictEqual(key, { headers: {} })
      assert.notEqual(key, span)

      sinon.assert.calledOnce(waf.disposeContext)
      sinon.assert.calledOnce(Reporter.finishRequest)
    })

    it('should skip WAF run when no response data', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({ span, headers: {}, method: 'GET', path: '/' })
      waf.run.reset()

      lambda.onLambdaEndInvocation({ span })

      sinon.assert.notCalled(waf.run)
      sinon.assert.calledOnce(waf.disposeContext)
      sinon.assert.calledOnce(Reporter.finishRequest)
    })

    it('should not process end-invocation twice for the same span', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({ span, headers: {}, method: 'GET', path: '/' })
      lambda.onLambdaEndInvocation({ span, statusCode: '200' })
      lambda.onLambdaEndInvocation({ span, statusCode: '200' })

      assert.equal(waf.disposeContext.callCount, 1)
      assert.equal(Reporter.finishRequest.callCount, 1)
    })

    it('should pass the span as rootSpan to Reporter.finishRequest', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({ span, headers: {}, method: 'GET', path: '/' })
      lambda.onLambdaEndInvocation({ span, statusCode: '200' })

      sinon.assert.calledOnce(Reporter.finishRequest)
      const args = Reporter.finishRequest.firstCall.args
      assert.equal(args[4], span)
    })

    it('should pass the request headers captured at start-invocation as req to Reporter.finishRequest', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({
        span,
        headers: { host: 'example.com', 'user-agent': 'system-tests' },
        method: 'GET',
        path: '/',
      })
      lambda.onLambdaEndInvocation({ span, statusCode: '200' })

      sinon.assert.calledOnce(Reporter.finishRequest)
      const [req, res, storedHeaders, body, rootSpan] = Reporter.finishRequest.firstCall.args
      assert.deepStrictEqual(req, { headers: { host: 'example.com', 'user-agent': 'system-tests' } })
      assert.equal(res, null)
      assert.deepStrictEqual(storedHeaders, {})
      assert.equal(body, undefined)
      assert.equal(rootSpan, span)
    })

    it('should pass a req with empty headers to Reporter.finishRequest when no headers were captured', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({ span, method: 'GET', path: '/' })
      lambda.onLambdaEndInvocation({ span, statusCode: '200' })

      sinon.assert.calledOnce(Reporter.finishRequest)
      const req = Reporter.finishRequest.firstCall.args[0]
      assert.deepStrictEqual(req, { headers: {} })
    })

    it('should catch errors and log them', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({ span, headers: {}, method: 'GET', path: '/' })
      waf.disposeContext.throws(new Error('boom'))

      lambda.onLambdaEndInvocation({ span, statusCode: '200' })

      sinon.assert.calledOnce(log.error)
    })

    it('should release the WAF context and finish the report when the work throws', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({ span, headers: {}, method: 'GET', path: '/' })
      waf.run.throws(new Error('boom'))

      lambda.onLambdaEndInvocation({ span, statusCode: '200' })

      sinon.assert.calledOnce(waf.disposeContext)
      sinon.assert.calledOnce(Reporter.finishRequest)
      sinon.assert.calledOnce(log.error)
    })

    it('should use the same synthetic req key across WAF run, dispose, and finishRequest', () => {
      const span = fakeSpan()

      lambda.onLambdaStartInvocation({
        span,
        headers: { host: 'example.com' },
        method: 'GET',
        path: '/',
      })

      lambda.onLambdaEndInvocation({ span, statusCode: '200' })

      const startKey = waf.run.firstCall.args[1]
      const endKey = waf.run.secondCall.args[1]
      const disposeKey = waf.disposeContext.firstCall.args[0]
      const finishReq = Reporter.finishRequest.firstCall.args[0]

      assert.equal(startKey, endKey)
      assert.equal(startKey, disposeKey)
      assert.equal(startKey, finishReq)
      // ...and it is the synthetic req, never the span.
      assert.notEqual(startKey, span)
      assert.deepStrictEqual(startKey, { headers: { host: 'example.com' } })
    })
  })

  describe('API Security', () => {
    let apiSecurity
    let telemetry

    // The real sampler is used here on purpose: the sampling key is built from the method and
    // route published on the start-invocation channel, and that plumbing is what these cases
    // are about. Only the telemetry sink is stubbed.
    beforeEach(() => {
      telemetry = {
        incrementApiSecRequestSchemaMetric: sinon.stub(),
        incrementApiSecRequestNoSchemaMetric: sinon.stub(),
        incrementApiSecMissingRouteMetric: sinon.stub(),
      }

      apiSecurity = proxyquire('../../src/appsec/api_security', {
        '../telemetry': telemetry,
      })

      apiSecurity.configure({
        appsec: { DD_API_SECURITY_ENABLED: true, DD_API_SECURITY_SAMPLE_DELAY: 30 },
        apmTracingEnabled: true,
      })

      lambda = proxyquire('../../src/appsec/lambda', {
        '../log': log,
        './waf': waf,
        './reporter': Reporter,
        '../priority_sampler': { keepTrace },
        './api_security': apiSecurity,
      })
    })

    afterEach(() => {
      // The sampler holds module-level state, so the TTL cache has to be cleared between cases.
      apiSecurity.disable()
    })

    const invoke = (span, options = {}) => {
      const { method = 'GET', statusCode = '200' } = options
      // Not a destructuring default: these cases need to pass an explicit undefined route.
      const route = 'route' in options ? options.route : '/api/{id}'

      lambda.onLambdaStartInvocation({ span, headers: {}, method, path: '/api/1', route })
      waf.run.resetHistory()
      lambda.onLambdaEndInvocation({ span, statusCode })
      return waf.run.firstCall?.args[0].persistent
    }

    it('should add the extract-schema processor when the invocation is sampled', () => {
      const persistent = invoke(fakeSpan())

      assert.deepStrictEqual(persistent[addresses.WAF_CONTEXT_PROCESSOR], { 'extract-schema': true })
    })

    it('should not add the processor when API Security is disabled', () => {
      apiSecurity.disable()

      const persistent = invoke(fakeSpan())

      assert.equal(persistent[addresses.WAF_CONTEXT_PROCESSOR], undefined)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
    })

    it('should not add the processor on a second invocation of the same endpoint', () => {
      const first = invoke(fakeSpan())
      const second = invoke(fakeSpan())

      assert.deepStrictEqual(first[addresses.WAF_CONTEXT_PROCESSOR], { 'extract-schema': true })
      assert.equal(second[addresses.WAF_CONTEXT_PROCESSOR], undefined)
    })

    it('should sample again when the route differs', () => {
      invoke(fakeSpan(), { route: '/api/{id}' })
      const other = invoke(fakeSpan(), { route: '/other/{id}' })

      assert.deepStrictEqual(other[addresses.WAF_CONTEXT_PROCESSOR], { 'extract-schema': true })
    })

    it('should sample again when the status code differs', () => {
      invoke(fakeSpan(), { statusCode: '200' })
      const other = invoke(fakeSpan(), { statusCode: '201' })

      assert.deepStrictEqual(other[addresses.WAF_CONTEXT_PROCESSOR], { 'extract-schema': true })
    })

    it('should not sample when the trace is rejected', () => {
      const persistent = invoke(fakeSpan({ priority: AUTO_REJECT }))

      assert.equal(persistent[addresses.WAF_CONTEXT_PROCESSOR], undefined)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
    })

    it('should not sample when the trace is rejected by the user', () => {
      const persistent = invoke(fakeSpan({ priority: USER_REJECT }))

      assert.equal(persistent[addresses.WAF_CONTEXT_PROCESSOR], undefined)
    })

    it('should not report missing_route for a rejected trace without route', () => {
      invoke(fakeSpan({ priority: AUTO_REJECT }), { route: undefined })

      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
    })

    it('should leave the TTL slot free after a rejected trace', () => {
      invoke(fakeSpan({ priority: AUTO_REJECT }))
      const kept = invoke(fakeSpan())

      assert.deepStrictEqual(kept[addresses.WAF_CONTEXT_PROCESSOR], { 'extract-schema': true })
    })

    it('should report missing_route when the event carried no route', () => {
      const span = fakeSpan()
      span.setTag('component', 'aws-lambda')

      const persistent = invoke(span, { route: undefined })

      assert.equal(persistent[addresses.WAF_CONTEXT_PROCESSOR], undefined)
      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecMissingRouteMetric, 'aws-lambda')
    })

    it('should not report missing_route on a 404 without route', () => {
      const persistent = invoke(fakeSpan(), { route: undefined, statusCode: '404' })

      assert.equal(persistent[addresses.WAF_CONTEXT_PROCESSOR], undefined)
      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
    })

    it('should skip sampling when the invocation has no status code', () => {
      const span = fakeSpan()
      lambda.onLambdaStartInvocation({ span, headers: {}, method: 'GET', path: '/', route: '/api/{id}' })
      waf.run.resetHistory()

      lambda.onLambdaEndInvocation({ span })

      sinon.assert.notCalled(waf.run)
      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
    })

    it('should emit request.schema when the WAF returned schema attributes', () => {
      const span = fakeSpan()
      span.setTag('component', 'aws-lambda')
      waf.run.returns({ attributes: { '_dd.appsec.s.req.body': [] } })

      invoke(span)

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestSchemaMetric, 'aws-lambda')
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
    })

    it('should emit request.no_schema when the WAF returned no schema attributes', () => {
      const span = fakeSpan()
      span.setTag('component', 'aws-lambda')

      invoke(span)

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestNoSchemaMetric, 'aws-lambda')
      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
    })

    it('should keep the response addresses alongside the processor', () => {
      const span = fakeSpan()
      lambda.onLambdaStartInvocation({ span, headers: {}, method: 'GET', path: '/', route: '/api/{id}' })
      waf.run.resetHistory()

      lambda.onLambdaEndInvocation({
        span,
        statusCode: '200',
        responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'foo=bar' },
      })

      const { persistent } = waf.run.firstCall.args[0]
      assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_CODE], '200')
      assert.deepStrictEqual(persistent[addresses.HTTP_INCOMING_RESPONSE_HEADERS], {
        'content-type': 'application/json',
      })
      assert.deepStrictEqual(persistent[addresses.WAF_CONTEXT_PROCESSOR], { 'extract-schema': true })
    })

    describe('response body', () => {
      const invokeWithBody = (data, options = {}) => {
        const span = options.span ?? fakeSpan()
        lambda.onLambdaStartInvocation({ span, headers: {}, method: 'GET', path: '/', route: '/api/{id}' })
        waf.run.resetHistory()

        lambda.onLambdaEndInvocation({
          span,
          statusCode: '200',
          responseHeaders: { 'content-type': 'application/json' },
          ...data,
        })

        return waf.run.firstCall?.args[0].persistent
      }

      it('should parse a JSON body published as a string', () => {
        const persistent = invokeWithBody({ responseBody: '{"payload":{"a":"b"}}' })

        assert.deepStrictEqual(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], { payload: { a: 'b' } })
      })

      it('should pass through a body that is already an object', () => {
        const persistent = invokeWithBody({ responseBody: { payload: 1 }, responseHeaders: undefined })

        assert.deepStrictEqual(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], { payload: 1 })
      })

      it('should decode a base64 encoded body', () => {
        const responseBody = Buffer.from('{"payload":[1,2]}').toString('base64')

        const persistent = invokeWithBody({ responseBody, isBase64Encoded: true })

        assert.deepStrictEqual(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], { payload: [1, 2] })
      })

      it('should accept a differently cased media type', () => {
        const persistent = invokeWithBody({
          responseBody: '{"payload":1}',
          responseHeaders: { 'content-type': 'Application/JSON' },
        })

        assert.deepStrictEqual(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], { payload: 1 })
      })

      it('should accept a media type with parameters', () => {
        const persistent = invokeWithBody({
          responseBody: '{"payload":1}',
          responseHeaders: { 'content-type': 'application/json; charset=utf-8' },
        })

        assert.deepStrictEqual(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], { payload: 1 })
      })

      it('should accept a structured JSON suffix media type', () => {
        const persistent = invokeWithBody({
          responseBody: '{"payload":1}',
          responseHeaders: { 'content-type': 'application/problem+json' },
        })

        assert.deepStrictEqual(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], { payload: 1 })
      })

      it('should accept text/json', () => {
        const persistent = invokeWithBody({
          responseBody: '{"payload":1}',
          responseHeaders: { 'content-type': 'text/json' },
        })

        assert.deepStrictEqual(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], { payload: 1 })
      })

      it('should reject a subtype that merely contains json', () => {
        const persistent = invokeWithBody({
          responseBody: '{"payload":1}',
          responseHeaders: { 'content-type': 'application/notjson' },
        })

        assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], undefined)
      })

      it('should reject a JSON sequence, which is not a single document', () => {
        const persistent = invokeWithBody({
          responseBody: '{"payload":1}',
          responseHeaders: { 'content-type': 'application/json-seq' },
        })

        assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], undefined)
      })

      it('should not be fooled by json appearing in a media type parameter', () => {
        const persistent = invokeWithBody({
          responseBody: '{"payload":1}',
          responseHeaders: { 'content-type': 'text/plain; filename=data.json' },
        })

        assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], undefined)
      })

      it('should not parse the body when the content type is not JSON', () => {
        const persistent = invokeWithBody({
          responseBody: '{"payload":1}',
          responseHeaders: { 'content-type': 'text/plain' },
        })

        assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], undefined)
      })

      it('should not parse a string body when there are no response headers', () => {
        const persistent = invokeWithBody({ responseBody: '{"payload":1}', responseHeaders: undefined })

        assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], undefined)
      })

      it('should swallow a malformed JSON body', () => {
        const persistent = invokeWithBody({ responseBody: '{not json' })

        assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], undefined)
        sinon.assert.notCalled(log.error)
      })

      it('should ignore a JSON scalar, which carries no schema', () => {
        const persistent = invokeWithBody({ responseBody: '"just a string"' })

        assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], undefined)
      })

      it('should ignore a body over the 16MB cap', () => {
        const responseBody = `{"payload":"${'a'.repeat(16 * 1024 * 1024)}"}`

        const persistent = invokeWithBody({ responseBody })

        assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], undefined)
      })

      it('should measure the cap in bytes, not in code units', () => {
        const responseBody = `{"payload":"${'デ'.repeat(6 * 1024 * 1024)}"}`
        assert.ok(responseBody.length < 16 * 1024 * 1024)

        const persistent = invokeWithBody({ responseBody })

        assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], undefined)
        sinon.assert.calledWithMatch(log.debug, sinon.match(/larger than/))
      })

      it('should reject an oversized base64 body from its encoded length alone', () => {
        const persistent = invokeWithBody({
          responseBody: 'A'.repeat(Math.ceil(16 * 1024 * 1024 * 4 / 3)),
          isBase64Encoded: true,
        })

        assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], undefined)
        sinon.assert.calledWithMatch(log.debug, sinon.match(/larger than/))
      })

      it('should ignore an empty body', () => {
        const persistent = invokeWithBody({ responseBody: '' })

        assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], undefined)
      })

      it('should not set the body when the invocation is not sampled', () => {
        // The first invocation takes the TTL slot, so the second one is skipped.
        invokeWithBody({ responseBody: '{"payload":1}' })
        const persistent = invokeWithBody({ responseBody: '{"payload":1}' })

        assert.equal(persistent[addresses.WAF_CONTEXT_PROCESSOR], undefined)
        assert.equal(persistent[addresses.HTTP_INCOMING_RESPONSE_BODY], undefined)
      })
    })
  })
})

// ─── WAF path safety: contract enforcement for non-HTTP req ───────────────────
//
// The WAFContextWrapper → Reporter chain (reportAttack, reportMetrics,
// reportAttributes) must not assume req is an HTTP IncomingMessage. In Lambda
// the req object is a synthetic { headers } key with no socket, body, or HTTP
// context attached.
//
// A Proxy-based `strictNonHttpReq` is used here (rather than the real Lambda
// req) to act as a trip-wire: it allows access to properties that have been
// audited as safe and throws on any NEW unaudited access. This forces
// developers to explicitly acknowledge and guard any new req property usage
// before it ships.
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
    const spanContext = {
      getTags () { return tags },
      getTag (key) { return tags[key] },
      setTag (key, value) { tags[key] = value },
      hasTag (key) { return key in tags },
    }
    return {
      addTags: sinon.stub().callsFake((obj) => Object.assign(tags, obj)),
      setTag: sinon.stub().callsFake((k, v) => { tags[k] = v }),
      context: sinon.stub().returns(spanContext),
      keep: sinon.stub(),
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
      incrementRequestDurationMetrics: sinon.stub(),
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

    assert.equal(span.context().getTag('appsec.event'), 'true')
    assert.ok(span.context().getTag('_dd.appsec.json'))
    assert.equal(span.context().getTag('network.client.ip'), undefined)
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
    assert.equal(span.context().getTag('appsec.event'), undefined)
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

    assert.ok(span.context().getTag('_dd.appsec.s.req.body'))
  })

  it('should complete finishRequest with span as req without crash', () => {
    const span = fakeSpan()

    RealReporter.finishRequest(span, null, {}, undefined, span)
  })

  it('should flush metricsQueue in finishRequest with span as req (Lambda production path)', () => {
    const span = fakeSpan()

    RealReporter.metricsQueue.set('_dd.appsec.waf.duration', 100)

    RealReporter.finishRequest(span, null, {}, undefined, span)

    assert.equal(span.context().getTag('_dd.appsec.waf.duration'), 100)
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
