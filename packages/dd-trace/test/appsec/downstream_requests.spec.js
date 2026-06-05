'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')
const sinon = require('sinon')

const downstream = require('../../src/appsec/downstream_requests')
const addresses = require('../../src/appsec/addresses')
const log = require('../../src/log')

describe('appsec downstream_requests', () => {
  let config
  let req
  let logWarnStub

  beforeEach(() => {
    config = {
      appsec: {
        apiSecurity: {
          enabled: true,
          downstreamBodyAnalysisSampleRate: 1,
          maxDownstreamRequestBodyAnalysis: 1,
          maxDownstreamBodyBytes: 1024,
        },
      },
    }

    logWarnStub = sinon.stub(log, 'warn')
    downstream.enable(config)
    req = {}
  })

  afterEach(() => {
    downstream.disable()
    sinon.restore()
  })

  describe('apiSecurity downstream body analysis sample rate', () => {
    it('logs warning and clamps value when sample rate is above 1', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamBodyAnalysisSampleRate = 1.5
      downstream.enable(config)

      sinon.assert.calledOnce(logWarnStub)
      sinon.assert.calledWith(
        logWarnStub,
        'DD_API_SECURITY_DOWNSTREAM_BODY_ANALYSIS_SAMPLE_RATE value is %s and it\'s out of range',
        1.5
      )
    })

    it('logs warning and clamps value when sample rate is below 0', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamBodyAnalysisSampleRate = -0.5
      downstream.enable(config)

      sinon.assert.calledOnce(logWarnStub)
      sinon.assert.calledWith(
        logWarnStub,
        'DD_API_SECURITY_DOWNSTREAM_BODY_ANALYSIS_SAMPLE_RATE value is %s and it\'s out of range',
        -0.5
      )
    })

    it('does not log warning when sample rate is within valid range', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamBodyAnalysisSampleRate = 0.5
      downstream.enable(config)

      const validRes = {
        statusCode: 200,
        headers: { 'content-type': 'application/json', 'content-length': '2' },
      }
      const ctx = {}
      downstream.planResponseBodyCollection(req, 'http://example.com/api', validRes, ctx)

      sinon.assert.notCalled(logWarnStub)
    })
  })

  describe('planResponseBodyCollection', () => {
    const validJsonRes = {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'content-length': '2' },
    }
    it('does nothing on redirect response (no ctx flags, no sampling until a non-redirect response)', () => {
      const inboundReq = {}
      const ctx = {}
      const res = {
        statusCode: 302,
        headers: { location: 'http://example.com/next' },
      }

      downstream.planResponseBodyCollection(inboundReq, 'http://example.com/first', res, ctx)

      assert.strictEqual(ctx.shouldCollectBody, undefined)

      const ctxAfter = {}
      downstream.planResponseBodyCollection(inboundReq, 'http://example.com/next', validJsonRes, ctxAfter)
      assert.strictEqual(ctxAfter.shouldCollectBody, true)
    })

    it('sets shouldCollectBody when sampling allows and response headers allow collection', () => {
      const inboundReq = {}
      const ctx = {}
      const res = {
        statusCode: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '12',
        },
      }

      downstream.planResponseBodyCollection(inboundReq, 'http://example.com/api', res, ctx)

      assert.strictEqual(ctx.shouldCollectBody, true)
    })

    it('records response body ignored metric when sampling allows but content-length is missing', () => {
      const web = require('../../src/plugins/util/web')
      const span = { setTag: sinon.stub() }
      sinon.stub(web, 'root').returns(span)

      const inboundReq = {}
      const ctx = {}
      const res = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
      }

      downstream.planResponseBodyCollection(inboundReq, 'http://example.com/api', res, ctx)

      assert.strictEqual(ctx.shouldCollectBody, undefined)
      const tag = '_dd.appsec.downstream_request.response_body_ignored.content_length_missing'
      sinon.assert.calledOnceWithExactly(span.setTag, tag, 1)
    })

    it('increments same ignored-body metric twice when two hops fail content-type on the same request', () => {
      const web = require('../../src/plugins/util/web')
      const span = { setTag: sinon.stub() }
      sinon.stub(web, 'root').returns(span)

      const inboundReq = {}
      const badRes = {
        statusCode: 200,
        headers: { 'content-type': 'image/png', 'content-length': '4' },
      }
      const ctx1 = {}
      const ctx2 = {}
      downstream.planResponseBodyCollection(inboundReq, 'http://example.com/a', badRes, ctx1)
      downstream.planResponseBodyCollection(inboundReq, 'http://example.com/b', badRes, ctx2)

      const tag = '_dd.appsec.downstream_request.response_body_ignored.content_type_invalid'
      sinon.assert.calledTwice(span.setTag)
      sinon.assert.calledWith(span.setTag, tag, 1)
      sinon.assert.calledWith(span.setTag, tag, 2)
    })

    it('records response body ignored metric when content-length exceeds configured max', () => {
      const web = require('../../src/plugins/util/web')
      const span = { setTag: sinon.stub() }
      sinon.stub(web, 'root').returns(span)

      const inboundReq = {}
      const ctx = {}
      const res = {
        statusCode: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '5000',
        },
      }

      downstream.planResponseBodyCollection(inboundReq, 'http://example.com/api', res, ctx)

      assert.strictEqual(ctx.shouldCollectBody, undefined)
      const tag = '_dd.appsec.downstream_request.response_body_ignored.content_length_too_big'
      sinon.assert.calledOnceWithExactly(span.setTag, tag, 1)
    })

    it('does not plan body collection when sample rate is zero', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamBodyAnalysisSampleRate = 0
      downstream.enable(config)

      const inboundReq = {}
      const ctx = {}
      downstream.planResponseBodyCollection(inboundReq, 'http://example.com/api', validJsonRes, ctx)
      assert.strictEqual(ctx.shouldCollectBody, undefined)
    })

    it('stops planning body collection when per-request analysis limit is reached', () => {
      const inboundReq = {}
      const ctx1 = {}
      downstream.planResponseBodyCollection(inboundReq, 'http://example.com/api', validJsonRes, ctx1)
      assert.strictEqual(ctx1.shouldCollectBody, true)

      const ctx2 = {}
      downstream.planResponseBodyCollection(inboundReq, 'http://example.com/api2', validJsonRes, ctx2)
      assert.strictEqual(ctx2.shouldCollectBody, undefined)
    })
  })

  describe('extractRequestData', () => {
    let ctx

    beforeEach(() => {
      ctx = {
        args: {
          options: {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Custom': ['a', 'b'],
            },
          },
        },
      }
    })

    it('collects method headers', () => {
      const addressesMap = downstream.extractRequestData(ctx, true)

      assert.strictEqual(addressesMap[addresses.HTTP_OUTGOING_METHOD], 'POST')
      assert.deepStrictEqual(addressesMap[addresses.HTTP_OUTGOING_HEADERS], {
        'content-type': 'application/json',
        'x-custom': ['a', 'b'],
      })
    })

    it('defaults method to GET when absent', () => {
      delete ctx.args.options.method

      const addressesMap = downstream.extractRequestData(ctx, false)

      assert.strictEqual(addressesMap[addresses.HTTP_OUTGOING_METHOD], 'GET')
    })

    it('returns empty headers when none present', () => {
      delete ctx.args.options.headers

      const addressesMap = downstream.extractRequestData(ctx, true)

      assert.ok(
        !Object.hasOwn(addressesMap, addresses.HTTP_OUTGOING_HEADERS),
        `Available keys: ${inspect(Object.keys(addressesMap))}`
      )
    })
  })

  describe('extractResponseData', () => {
    let res

    beforeEach(() => {
      res = {
        statusCode: 201,
        headers: {
          'content-type': 'application/json',
          'set-cookie': ['a=1', 'b=2'],
        },
      }
    })

    it('collects status and headers', () => {
      const addressesMap = downstream.extractResponseData(res)

      assert.strictEqual(addressesMap[addresses.HTTP_OUTGOING_RESPONSE_STATUS], '201')
      assert.deepStrictEqual(addressesMap[addresses.HTTP_OUTGOING_RESPONSE_HEADERS], {
        'content-type': 'application/json',
        'set-cookie': ['a=1', 'b=2'],
      })
    })

    it('parses response body when provided', () => {
      const body = Buffer.from(JSON.stringify({ ok: true }))
      const addressesMap = downstream.extractResponseData(res, body)

      assert.deepStrictEqual(addressesMap[addresses.HTTP_OUTGOING_RESPONSE_BODY], { ok: true })
    })

    it('parses urlencoded response body when provided', () => {
      const urlRes = {
        statusCode: 200,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }
      const body = Buffer.from('a=1&b=2')
      const addressesMap = downstream.extractResponseData(urlRes, body)

      assert.deepStrictEqual(addressesMap[addresses.HTTP_OUTGOING_RESPONSE_BODY], { a: '1', b: '2' })
    })

    it('omits body when not provided', () => {
      const addressesMap = downstream.extractResponseData(res)

      assert.ok(
        !Object.hasOwn(addressesMap, addresses.HTTP_OUTGOING_RESPONSE_BODY),
        `Available keys: ${inspect(Object.keys(addressesMap))}`
      )
    })
  })

  describe('incrementDownstreamAnalysisCount', () => {
    let web
    let span

    beforeEach(() => {
      web = require('../../src/plugins/util/web')
      span = {
        setTag: sinon.stub(),
      }
    })

    it('increments count and sets metric on span', () => {
      sinon.stub(web, 'root').returns(span)

      downstream.incrementDownstreamAnalysisCount(req)

      sinon.assert.calledOnceWithExactly(span.setTag, '_dd.appsec.downstream_request', 1)
    })

    it('increments count on multiple calls', () => {
      sinon.stub(web, 'root').returns(span)

      downstream.incrementDownstreamAnalysisCount(req)
      downstream.incrementDownstreamAnalysisCount(req)
      downstream.incrementDownstreamAnalysisCount(req)

      sinon.assert.calledThrice(span.setTag)
      sinon.assert.calledWith(span.setTag, '_dd.appsec.downstream_request', 1)
      sinon.assert.calledWith(span.setTag, '_dd.appsec.downstream_request', 2)
      sinon.assert.calledWith(span.setTag, '_dd.appsec.downstream_request', 3)
    })

    it('does not error when span is null', () => {
      sinon.stub(web, 'root').returns(null)

      downstream.incrementDownstreamAnalysisCount(req)
    })

    it('tracks count per request independently', () => {
      sinon.stub(web, 'root').returns(span)
      const req1 = {}
      const req2 = {}

      downstream.incrementDownstreamAnalysisCount(req1)
      downstream.incrementDownstreamAnalysisCount(req2)
      downstream.incrementDownstreamAnalysisCount(req1)

      assert.deepStrictEqual(span.setTag.getCall(0).args, ['_dd.appsec.downstream_request', 1])
      assert.deepStrictEqual(span.setTag.getCall(1).args, ['_dd.appsec.downstream_request', 1])
      assert.deepStrictEqual(span.setTag.getCall(2).args, ['_dd.appsec.downstream_request', 2])
    })
  })

  describe('sampling behavior via planResponseBodyCollection', () => {
    const validJsonRes = {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'content-length': '2' },
    }

    it('collects body on every hop at sample rate 1.0 (100%)', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamBodyAnalysisSampleRate = 1.0
      config.appsec.apiSecurity.maxDownstreamRequestBodyAnalysis = 100
      downstream.enable(config)

      for (let i = 0; i < 10; i++) {
        const inboundReq = {}
        const ctx = {}
        downstream.planResponseBodyCollection(inboundReq, `http://example.com/${i}`, validJsonRes, ctx)
        assert.strictEqual(ctx.shouldCollectBody, true)
      }
    })

    it('never collects at sample rate 0.0 (0%)', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamBodyAnalysisSampleRate = 0.0
      config.appsec.apiSecurity.maxDownstreamRequestBodyAnalysis = 100
      downstream.enable(config)

      for (let i = 0; i < 10; i++) {
        const inboundReq = {}
        const ctx = {}
        downstream.planResponseBodyCollection(inboundReq, `http://example.com/${i}`, validJsonRes, ctx)
        assert.strictEqual(ctx.shouldCollectBody, undefined)
      }
    })

    it('produces some collects and some skips with rate 0.5', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamBodyAnalysisSampleRate = 0.5
      config.appsec.apiSecurity.maxDownstreamRequestBodyAnalysis = 1000
      downstream.enable(config)

      const results = []
      for (let i = 0; i < 100; i++) {
        const inboundReq = {}
        const ctx = {}
        downstream.planResponseBodyCollection(inboundReq, `http://example.com/${i}`, validJsonRes, ctx)
        results.push(ctx.shouldCollectBody === true)
      }

      const trueCount = results.filter(r => r).length
      const falseCount = results.filter(r => !r).length

      assert.ok(trueCount > 0, `Expected ${trueCount} > 0`)
      assert.ok(falseCount > 0, `Expected ${falseCount} > 0`)
    })

    it('tracks per-request body analysis count independently', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamBodyAnalysisSampleRate = 1.0
      config.appsec.apiSecurity.maxDownstreamRequestBodyAnalysis = 2
      downstream.enable(config)

      const req1 = {}
      const req2 = {}

      const c1 = {}
      downstream.planResponseBodyCollection(req1, 'http://example.com/1', validJsonRes, c1)
      assert.strictEqual(c1.shouldCollectBody, true)

      const c2 = {}
      downstream.planResponseBodyCollection(req2, 'http://example.com/2', validJsonRes, c2)
      assert.strictEqual(c2.shouldCollectBody, true)

      const c3 = {}
      downstream.planResponseBodyCollection(req1, 'http://example.com/3', validJsonRes, c3)
      assert.strictEqual(c3.shouldCollectBody, true)

      const c4 = {}
      downstream.planResponseBodyCollection(req1, 'http://example.com/4', validJsonRes, c4)
      assert.strictEqual(c4.shouldCollectBody, undefined)

      const c5 = {}
      downstream.planResponseBodyCollection(req2, 'http://example.com/5', validJsonRes, c5)
      assert.strictEqual(c5.shouldCollectBody, true)
    })

    it('increments counter only after successful header-based collection plan', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamBodyAnalysisSampleRate = 1.0
      config.appsec.apiSecurity.maxDownstreamRequestBodyAnalysis = 3
      downstream.enable(config)

      const testReq = {}

      for (let i = 0; i < 3; i++) {
        const ctx = {}
        downstream.planResponseBodyCollection(testReq, `http://example.com/${i}`, validJsonRes, ctx)
        assert.strictEqual(ctx.shouldCollectBody, true)
      }

      const ctxLast = {}
      downstream.planResponseBodyCollection(testReq, 'http://example.com/last', validJsonRes, ctxLast)
      assert.strictEqual(ctxLast.shouldCollectBody, undefined)
    })
  })
})
