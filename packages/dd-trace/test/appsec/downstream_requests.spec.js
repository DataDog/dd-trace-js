'use strict'

const { expect } = require('chai')

const downstream = require('../../src/appsec/downstream_requests')
const addresses = require('../../src/appsec/addresses')

describe('appsec downstream_requests', () => {
  let config
  let req

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

    downstream.enable(config)
    req = {}
  })

  afterEach(() => {
    downstream.disable()
  })

  describe('shouldSampleBody', () => {
    it('returns true when enabled with sample rate 1', () => {
      expect(downstream.shouldSampleBody(req)).to.be.true
    })

    it('returns false when per-request limit reached', () => {
      expect(downstream.shouldSampleBody(req)).to.be.true
      downstream.incrementBodyAnalysisCount(req)

      expect(downstream.shouldSampleBody(req)).to.be.false
    })

    it('returns false when sample rate is zero', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamRequestBodyAnalysisSampleRate = 0
      downstream.enable(config)

      expect(downstream.shouldSampleBody(req)).to.be.false
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
      const addressesMap = downstream.extractResponseData(res, false)

      expect(addressesMap[addresses.HTTP_OUTGOING_RESPONSE_STATUS]).to.equal('201')
      expect(addressesMap[addresses.HTTP_OUTGOING_RESPONSE_HEADERS]).to.deep.equal({
        'content-type': 'application/json',
        'set-cookie': ['a=1', 'b=2']
      })
    })

    it('parses response body when allowed', () => {
      const body = Buffer.from(JSON.stringify({ ok: true }))
      const addressesMap = downstream.extractResponseData(res, true, body)

      expect(addressesMap[addresses.HTTP_OUTGOING_RESPONSE_BODY]).to.deep.equal({ ok: true })
    })

    it('omits body when not provided', () => {
      const addressesMap = downstream.extractResponseData(res, true)

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

      it('returns already parsed JSON objects', () => {
        const obj = { foo: 1 }
        expect(downstream.parseBody(obj, 'application/json')).to.equal(obj)
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

  describe('getResponseContentType', () => {
    it('returns content-type in lowercase', () => {
      expect(downstream.getResponseContentType({ 'content-type': 'application/json' })).to.equal('application/json')
    })

    it('returns Content-Type with capital C and T', () => {
      expect(downstream.getResponseContentType({ 'Content-Type': 'text/html' })).to.equal('text/html')
    })

    it('returns CONTENT-TYPE all uppercase', () => {
      expect(downstream.getResponseContentType({ 'CONTENT-TYPE': 'text/plain' })).to.equal('text/plain')
    })

    it('returns null when headers is null', () => {
      expect(downstream.getResponseContentType(null)).to.equal(null)
    })
  })

  describe('determineMethod', () => {
    it('returns method when valid string', () => {
      expect(downstream.determineMethod('POST')).to.equal('POST')
    })

    it('returns GET when method is null', () => {
      expect(downstream.determineMethod(null)).to.equal('GET')
    })

    it('returns GET when method is not a string', () => {
      expect(downstream.determineMethod(123)).to.equal('GET')
    })
  })

  describe('addDownstreamRequestMetric', () => {
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

    it('sets metric on span when span exists', () => {
      const webRootStub = require('sinon').stub(web, 'root').returns(span)

      downstream.addDownstreamRequestMetric(req)

      require('sinon').assert.calledOnceWithExactly(span.setTag, '_dd.appsec.downstream_request', 1.0)
      webRootStub.restore()
    })

    it('does not error when span is null', () => {
      const webRootStub = require('sinon').stub(web, 'root').returns(null)

      expect(() => downstream.addDownstreamRequestMetric(req)).to.not.throw()
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

      expect(downstream.shouldSampleBody(req1)).to.be.true
      downstream.incrementBodyAnalysisCount(req1)

      expect(downstream.shouldSampleBody(req2)).to.be.true
      downstream.incrementBodyAnalysisCount(req2)

      expect(downstream.shouldSampleBody(req1)).to.be.true
      downstream.incrementBodyAnalysisCount(req1)

      expect(downstream.shouldSampleBody(req1)).to.be.false
      expect(downstream.shouldSampleBody(req2)).to.be.true
    })

    it('increments counter correctly', () => {
      downstream.disable()
      config.appsec.apiSecurity.downstreamRequestBodyAnalysisSampleRate = 1.0
      config.appsec.apiSecurity.maxDownstreamRequestBodyAnalysis = 3
      downstream.enable(config)

      const testReq = {}

      // Should sample 3 times
      expect(downstream.shouldSampleBody(testReq)).to.be.true
      downstream.incrementBodyAnalysisCount(testReq)

      expect(downstream.shouldSampleBody(testReq)).to.be.true
      downstream.incrementBodyAnalysisCount(testReq)

      expect(downstream.shouldSampleBody(testReq)).to.be.true
      downstream.incrementBodyAnalysisCount(testReq)

      // Fourth time should be false
      expect(downstream.shouldSampleBody(testReq)).to.be.false
    })
  })
})
