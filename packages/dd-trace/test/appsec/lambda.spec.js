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
  })
})
