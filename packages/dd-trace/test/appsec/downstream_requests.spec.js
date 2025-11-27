'use strict'

const { expect } = require('chai')
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
          downstreamRequestBodyAnalysisSampleRate: 1,
          maxDownstreamRequestBodyAnalysis: 1
        }
      }
    }

    logWarnStub = sinon.stub(log, 'warn')
    downstream.enable(config)
    req = {}
  })

  afterEach(() => {
    downstream.disable()
    logWarnStub.restore()
  })

  describe('shouldSampleBody', () => {
    const testUrl = 'http://example.com/api'

    it('returns true when enabled with sample rate 1', () => {
      expect(downstream.shouldSampleBody(req, testUrl)).to.be.true
    })

    it('returns false when per-request limit reached', () => {
      expect(downstream.shouldSampleBody(req, testUrl)).to.be.true
      expect(downstream.shouldSampleBody(req, 'http://example.com/api2')).to.be.false
    })

    it('returns false when sample rate is zero', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamRequestBodyAnalysisSampleRate = 0
      downstream.enable(config)

      expect(downstream.shouldSampleBody(req, testUrl)).to.be.false
    })

    it('returns stored decision from redirect', () => {
      const redirectUrl = 'http://example.com/redirect-target'
      downstream.storeRedirectBodyCollectionDecision(req, redirectUrl)

      expect(downstream.shouldSampleBody(req, redirectUrl)).to.be.true
    })

    it('logs warning and clamps value when sample rate is above 1', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamRequestBodyAnalysisSampleRate = 1.5
      downstream.enable(config)

      sinon.assert.calledOnce(logWarnStub)
      sinon.assert.calledWith(
        logWarnStub,
        'DD_API_SECURITY_DOWNSTREAM_REQUEST_BODY_ANALYSIS_SAMPLE_RATE value is %s and it\'s out of range',
        1.5
      )
    })

    it('logs warning and clamps value when sample rate is below 0', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamRequestBodyAnalysisSampleRate = -0.5
      downstream.enable(config)

      sinon.assert.calledOnce(logWarnStub)
      sinon.assert.calledWith(
        logWarnStub,
        'DD_API_SECURITY_DOWNSTREAM_REQUEST_BODY_ANALYSIS_SAMPLE_RATE value is %s and it\'s out of range',
        -0.5
      )
    })

    it('does not log warning when sample rate is within valid range', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamRequestBodyAnalysisSampleRate = 0.5
      downstream.enable(config)

      downstream.shouldSampleBody(req, testUrl)

      sinon.assert.notCalled(logWarnStub)
    })
  })

  describe('handleRedirectResponse', () => {
    it('detects redirect with location header', () => {
      const res = {
        statusCode: 302,
        headers: { location: 'http://example.com/redirect' }
      }

      const isRedirect = downstream.handleRedirectResponse(req, res, true)

      expect(isRedirect).to.be.true
    })

    it('returns false for non redirect status codes', () => {
      const res = {
        statusCode: 200,
        headers: {}
      }

      const isRedirect = downstream.handleRedirectResponse(req, res, true)

      expect(isRedirect).to.be.false
    })

    it('returns false for redirect without location header', () => {
      const res = {
        statusCode: 302,
        headers: {}
      }

      const isRedirect = downstream.handleRedirectResponse(req, res, true)

      expect(isRedirect).to.be.true
    })

    it('stores body collection decision for redirect', () => {
      const res = {
        statusCode: 302,
        headers: { location: 'http://example.com/target' }
      }

      downstream.handleRedirectResponse(req, res)

      const storedDecision = downstream.shouldSampleBody(req, 'http://example.com/target')
      expect(storedDecision).to.be.true
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
              'X-Custom': ['a', 'b']
            }
          }
        }
      }
    })

    it('collects method headers', () => {
      const addressesMap = downstream.extractRequestData(ctx, true)

      expect(addressesMap[addresses.HTTP_OUTGOING_METHOD]).to.equal('POST')
      expect(addressesMap[addresses.HTTP_OUTGOING_HEADERS]).to.deep.equal({
        'Content-Type': 'application/json',
        'X-Custom': ['a', 'b']
      })
    })

    it('defaults method to GET when absent', () => {
      delete ctx.args.options.method

      const addressesMap = downstream.extractRequestData(ctx, false)

      expect(addressesMap[addresses.HTTP_OUTGOING_METHOD]).to.equal('GET')
    })

    it('returns empty headers when none present', () => {
      delete ctx.args.options.headers

      const addressesMap = downstream.extractRequestData(ctx, true)

      expect(addressesMap).to.not.have.property(addresses.HTTP_OUTGOING_HEADERS)
    })
  })

  describe('extractResponseData', () => {
    let res

    beforeEach(() => {
      res = {
        statusCode: 201,
        headers: {
          'content-type': 'application/json',
          'set-cookie': ['a=1', 'b=2']
        }
      }
    })

    it('collects status and headers', () => {
      const addressesMap = downstream.extractResponseData(res)

      expect(addressesMap[addresses.HTTP_OUTGOING_RESPONSE_STATUS]).to.equal('201')
      expect(addressesMap[addresses.HTTP_OUTGOING_RESPONSE_HEADERS]).to.deep.equal({
        'content-type': 'application/json',
        'set-cookie': ['a=1', 'b=2']
      })
    })

    it('parses response body when provided', () => {
      const body = Buffer.from(JSON.stringify({ ok: true }))
      const addressesMap = downstream.extractResponseData(res, body)

      expect(addressesMap[addresses.HTTP_OUTGOING_RESPONSE_BODY]).to.deep.equal({ ok: true })
    })

    it('omits body when not provided', () => {
      const addressesMap = downstream.extractResponseData(res)

      expect(addressesMap).to.not.have.property(addresses.HTTP_OUTGOING_RESPONSE_BODY)
    })
  })

  describe('parseBody', () => {
    describe('JSON parsing', () => {
      it('parses JSON strings', () => {
        expect(downstream.parseBody('{"foo":1}', 'application/json')).to.deep.equal({ foo: 1 })
      })

      it('parses JSON buffers', () => {
        const buffer = Buffer.from('{"foo":1}')
        expect(downstream.parseBody(buffer, 'application/json')).to.deep.equal({ foo: 1 })
      })

      it('handles text/json content type', () => {
        expect(downstream.parseBody('{"foo":1}', 'text/json')).to.deep.equal({ foo: 1 })
      })

      it('handles content-type with charset', () => {
        expect(downstream.parseBody('{"foo":1}', 'application/json; charset=utf-8')).to.deep.equal({ foo: 1 })
      })

      it('returns null for invalid JSON', () => {
        expect(downstream.parseBody('{invalid}', 'application/json')).to.equal(null)
      })

      it('returns null for non-object JSON', () => {
        expect(downstream.parseBody(123, 'application/json')).to.equal(null)
      })
    })

    describe('URL-encoded parsing', () => {
      it('parses urlencoded strings', () => {
        const parsed = downstream.parseBody('a=1&b=2', 'application/x-www-form-urlencoded')
        expect(parsed).to.deep.equal({ a: '1', b: '2' })
      })

      it('parses urlencoded buffers', () => {
        const buffer = Buffer.from('a=1&b=2')
        const parsed = downstream.parseBody(buffer, 'application/x-www-form-urlencoded')
        expect(parsed).to.deep.equal({ a: '1', b: '2' })
      })

      it('handles multiple values for same key', () => {
        const parsed = downstream.parseBody('a=1&a=2&b=3', 'application/x-www-form-urlencoded')
        expect(parsed).to.deep.equal({ a: ['1', '2'], b: '3' })
      })

      it('handles URL encoded values', () => {
        const parsed = downstream.parseBody('name=John%20Doe&city=New%20York', 'application/x-www-form-urlencoded')
        expect(parsed).to.deep.equal({ name: 'John Doe', city: 'New York' })
      })

      it('handles empty values', () => {
        const parsed = downstream.parseBody('a=&b=2', 'application/x-www-form-urlencoded')
        expect(parsed).to.deep.equal({ a: '', b: '2' })
      })
    })

    describe('Unsupported content types', () => {
      it('returns null for text/plain', () => {
        expect(downstream.parseBody('text', 'text/plain')).to.equal(null)
      })

      it('returns null for multipart/form-data', () => {
        expect(downstream.parseBody('data', 'multipart/form-data')).to.equal(null)
      })

      it('returns null for text/html', () => {
        expect(downstream.parseBody('<html></html>', 'text/html')).to.equal(null)
      })

      it('returns null for application/xml', () => {
        expect(downstream.parseBody('<xml></xml>', 'application/xml')).to.equal(null)
      })
    })

    describe('Edge cases', () => {
      it('returns null when body is null', () => {
        expect(downstream.parseBody(null, 'application/json')).to.equal(null)
      })

      it('returns null when body is undefined', () => {
        expect(downstream.parseBody(undefined, 'application/json')).to.equal(null)
      })

      it('returns null when contentType is null', () => {
        expect(downstream.parseBody('{"foo":1}', null)).to.equal(null)
      })

      it('returns null when parsing fails', () => {
        expect(downstream.parseBody('not json', 'application/json')).to.equal(null)
      })
    })
  })

  describe('getMethod', () => {
    it('returns method when valid string', () => {
      expect(downstream.getMethod('POST')).to.equal('POST')
    })

    it('returns GET when method is null', () => {
      expect(downstream.getMethod(null)).to.equal('GET')
    })

    it('returns GET when method is not a string', () => {
      expect(downstream.getMethod(123)).to.equal('GET')
    })
  })

  describe('incrementDownstreamAnalysisCount', () => {
    let web
    let span

    beforeEach(() => {
      web = require('../../src/plugins/util/web')
      span = {
        setTag: require('sinon').stub()
      }
    })

    afterEach(() => {
      require('sinon').restore()
    })

    it('increments count and sets metric on span', () => {
      const webRootStub = require('sinon').stub(web, 'root').returns(span)

      downstream.incrementDownstreamAnalysisCount(req)

      require('sinon').assert.calledOnceWithExactly(span.setTag, '_dd.appsec.downstream_request', 1)
      webRootStub.restore()
    })

    it('increments count on multiple calls', () => {
      const webRootStub = require('sinon').stub(web, 'root').returns(span)

      downstream.incrementDownstreamAnalysisCount(req)
      downstream.incrementDownstreamAnalysisCount(req)
      downstream.incrementDownstreamAnalysisCount(req)

      require('sinon').assert.calledThrice(span.setTag)
      require('sinon').assert.calledWith(span.setTag, '_dd.appsec.downstream_request', 1)
      require('sinon').assert.calledWith(span.setTag, '_dd.appsec.downstream_request', 2)
      require('sinon').assert.calledWith(span.setTag, '_dd.appsec.downstream_request', 3)
      webRootStub.restore()
    })

    it('does not error when span is null', () => {
      const webRootStub = require('sinon').stub(web, 'root').returns(null)

      expect(() => downstream.incrementDownstreamAnalysisCount(req)).to.not.throw()
      webRootStub.restore()
    })

    it('tracks count per request independently', () => {
      const webRootStub = require('sinon').stub(web, 'root').returns(span)
      const req1 = {}
      const req2 = {}

      downstream.incrementDownstreamAnalysisCount(req1)
      downstream.incrementDownstreamAnalysisCount(req2)
      downstream.incrementDownstreamAnalysisCount(req1)

      expect(span.setTag.getCall(0).args).to.deep.equal(['_dd.appsec.downstream_request', 1])
      expect(span.setTag.getCall(1).args).to.deep.equal(['_dd.appsec.downstream_request', 1])
      expect(span.setTag.getCall(2).args).to.deep.equal(['_dd.appsec.downstream_request', 2])
      webRootStub.restore()
    })
  })

  describe('sampling behavior', () => {
    it('returns true for sample rate 1.0 (100%)', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamRequestBodyAnalysisSampleRate = 1.0
      config.appsec.apiSecurity.maxDownstreamRequestBodyAnalysis = 100
      downstream.enable(config)

      for (let i = 0; i < 10; i++) {
        expect(downstream.shouldSampleBody({})).to.be.true
      }
    })

    it('returns false for sample rate 0.0 (0%)', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamRequestBodyAnalysisSampleRate = 0.0
      config.appsec.apiSecurity.maxDownstreamRequestBodyAnalysis = 100
      downstream.enable(config)

      for (let i = 0; i < 10; i++) {
        expect(downstream.shouldSampleBody({})).to.be.false
      }
    })

    it('produces some true and some false with rate 0.5', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamRequestBodyAnalysisSampleRate = 0.5
      config.appsec.apiSecurity.maxDownstreamRequestBodyAnalysis = 1000
      downstream.enable(config)

      const results = []
      for (let i = 0; i < 100; i++) {
        results.push(downstream.shouldSampleBody({}))
      }

      const trueCount = results.filter(r => r).length
      const falseCount = results.filter(r => !r).length

      expect(trueCount).to.be.greaterThan(0)
      expect(falseCount).to.be.greaterThan(0)
    })

    it('tracks per-request body analysis count independently', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamRequestBodyAnalysisSampleRate = 1.0
      config.appsec.apiSecurity.maxDownstreamRequestBodyAnalysis = 2
      downstream.enable(config)

      const req1 = {}
      const req2 = {}

      expect(downstream.shouldSampleBody(req1, 'http://example.com/1')).to.be.true
      expect(downstream.shouldSampleBody(req2, 'http://example.com/2')).to.be.true
      expect(downstream.shouldSampleBody(req1, 'http://example.com/3')).to.be.true

      expect(downstream.shouldSampleBody(req1, 'http://example.com/4')).to.be.false
      expect(downstream.shouldSampleBody(req2, 'http://example.com/5')).to.be.true
    })

    it('increments counter correctly', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamRequestBodyAnalysisSampleRate = 1.0
      config.appsec.apiSecurity.maxDownstreamRequestBodyAnalysis = 3
      downstream.enable(config)

      const testReq = {}

      // Should sample 3 times
      expect(downstream.shouldSampleBody(testReq)).to.be.true
      expect(downstream.shouldSampleBody(testReq)).to.be.true
      expect(downstream.shouldSampleBody(testReq)).to.be.true

      // Fourth time should be false
      expect(downstream.shouldSampleBody(testReq)).to.be.false
    })
  })
})
