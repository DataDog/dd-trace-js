'use strict'

const proxyquire = require('proxyquire')
const { storage } = require('../../../datadog-core')
const zlib = require('zlib')

describe('reporter', () => {
  let Reporter
  let span
  let web
  let telemetry
  let isStandaloneEnabled

  beforeEach(() => {
    span = {
      context: sinon.stub().returns({
        _tags: {}
      }),
      addTags: sinon.stub(),
      setTag: sinon.stub()
    }

    web = {
      root: sinon.stub().returns(span)
    }

    telemetry = {
      incrementWafInitMetric: sinon.stub(),
      updateWafRequestsMetricTags: sinon.stub(),
      incrementWafUpdatesMetric: sinon.stub(),
      incrementWafRequestsMetric: sinon.stub(),
      getRequestMetrics: sinon.stub()
    }

    isStandaloneEnabled = sinon.stub().returns(false)

    Reporter = proxyquire('../../src/appsec/reporter', {
      '../plugins/util/web': web,
      './telemetry': telemetry,
      './standalone': {
        isStandaloneEnabled
      }
    })
  })

  afterEach(() => {
    sinon.restore()
    Reporter.setRateLimit(100)
    Reporter.metricsQueue.clear()
  })

  describe('filterHeaders', () => {
    it('should return empty object when providing no headers', () => {
      const result = Reporter.filterHeaders(null)

      expect(result).to.be.an('object').that.is.empty
    })

    it('should filter and format headers from passlist', () => {
      const result = Reporter.filterHeaders({
        host: 'localhost',
        'user-agent': 42,
        secret: 'password',
        'x-forwarded-for': '10'
      }, Reporter.mapHeaderAndTags([
        'host',
        'user-agent',
        'x-forwarded-for',
        'x-client-ip'
      ], 'prefix.'))

      expect(result).to.deep.equal({
        'prefix.host': 'localhost',
        'prefix.user-agent': '42',
        'prefix.x-forwarded-for': '10'
      })
    })
  })

  describe('formatHeaderName', () => {
    it('should format a string', () => {
      expect(Reporter.formatHeaderName('Content-Type')).to.equal('content-type')
      expect(Reporter.formatHeaderName(' Content-Type ')).to.equal('content-type')
      expect(Reporter.formatHeaderName('C!!!ont_____ent----tYp!/!e')).to.equal('c___ont_____ent----typ_/_e')
      expect(Reporter.formatHeaderName('Some.Header')).to.equal('some_header')
      expect(Reporter.formatHeaderName(''.padEnd(300, 'a'))).to.have.lengthOf(200)
    })
  })

  describe('reportWafInit', () => {
    const wafVersion = '0.0.1'
    const rulesVersion = '0.0.2'
    const diagnosticsRules = {
      loaded: ['1', '3', '4'],
      failed: ['2'],
      errors: { error: 'error parsing rule 2' }
    }

    it('should add some entries to metricsQueue', () => {
      Reporter.reportWafInit(wafVersion, rulesVersion, diagnosticsRules)

      expect(Reporter.metricsQueue.get('_dd.appsec.waf.version')).to.be.eq(wafVersion)
      expect(Reporter.metricsQueue.get('_dd.appsec.event_rules.loaded')).to.be.eq(3)
      expect(Reporter.metricsQueue.get('_dd.appsec.event_rules.error_count')).to.be.eq(1)
      expect(Reporter.metricsQueue.get('_dd.appsec.event_rules.errors'))
        .to.be.eq(JSON.stringify(diagnosticsRules.errors))
      expect(Reporter.metricsQueue.get('manual.keep')).to.be.eq('true')
    })

    it('should call incrementWafInitMetric', () => {
      Reporter.reportWafInit(wafVersion, rulesVersion, diagnosticsRules)

      expect(telemetry.incrementWafInitMetric).to.have.been.calledOnceWithExactly(wafVersion, rulesVersion)
    })

    it('should not fail with undefined arguments', () => {
      const wafVersion = undefined
      const rulesVersion = undefined
      const diagnosticsRules = undefined

      Reporter.reportWafInit(wafVersion, rulesVersion, diagnosticsRules)

      expect(Reporter.metricsQueue.get('_dd.appsec.event_rules.loaded')).to.be.eq(0)
      expect(Reporter.metricsQueue.get('_dd.appsec.event_rules.error_count')).to.be.eq(0)

      expect(telemetry.incrementWafInitMetric).to.have.been.calledOnceWithExactly(wafVersion, rulesVersion)
    })

    it('should not add _dd.p.appsec entrie if standalone ASM disabled', () => {
      Reporter.reportWafInit(wafVersion, rulesVersion, diagnosticsRules)
      expect(Reporter.metricsQueue.get('_dd.p.appsec')).to.be.undefined
    })

    it('should add _dd.p.appsec entrie if standalone ASM enabled', () => {
      isStandaloneEnabled.returns(true)

      Reporter.reportWafInit(wafVersion, rulesVersion, diagnosticsRules)
      expect(Reporter.metricsQueue.get('_dd.p.appsec')).to.be.eq(1)
    })
  })

  describe('reportMetrics', () => {
    let req

    beforeEach(() => {
      req = {}
      storage.enterWith({ req })
    })

    afterEach(() => {
      storage.disable()
    })

    it('should do nothing when passed incomplete objects', () => {
      web.root.returns(null)

      Reporter.reportMetrics({})

      expect(span.setTag).not.to.have.been.called
    })

    it('should set duration metrics if set', () => {
      const metrics = { duration: 1337 }
      Reporter.reportMetrics(metrics)

      expect(web.root).to.have.been.calledOnceWithExactly(req)
      expect(telemetry.updateWafRequestsMetricTags).to.have.been.calledOnceWithExactly(metrics, req)
    })

    it('should set ext duration metrics if set', () => {
      const metrics = { durationExt: 42 }
      Reporter.reportMetrics(metrics)

      expect(web.root).to.have.been.calledOnceWithExactly(req)
      expect(telemetry.updateWafRequestsMetricTags).to.have.been.calledOnceWithExactly(metrics, req)
    })

    it('should set rulesVersion if set', () => {
      Reporter.reportMetrics({ rulesVersion: '1.2.3' })

      expect(web.root).to.have.been.calledOnceWithExactly(req)
      expect(span.setTag).to.have.been.calledOnceWithExactly('_dd.appsec.event_rules.version', '1.2.3')
    })

    it('should call updateWafRequestsMetricTags', () => {
      const metrics = { rulesVersion: '1.2.3' }
      const store = storage.getStore()

      Reporter.reportMetrics(metrics)

      expect(telemetry.updateWafRequestsMetricTags).to.have.been.calledOnceWithExactly(metrics, store.req)
    })
  })

  describe('reportAttack', () => {
    let req

    beforeEach(() => {
      req = {
        socket: {
          remoteAddress: '8.8.8.8'
        },
        headers: {
          host: 'localhost',
          'user-agent': 'arachni'
        }
      }
      storage.enterWith({ req })
    })

    afterEach(() => {
      storage.disable()
    })

    it('should add tags to request span', () => {
      const result = Reporter.reportAttack('[{"rule":{},"rule_matches":[{}]}]')
      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'appsec.event': 'true',
        'manual.keep': 'true',
        '_dd.origin': 'appsec',
        '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]}]}',
        'http.request.headers.host': 'localhost',
        'http.request.headers.user-agent': 'arachni',
        'http.useragent': 'arachni',
        'network.client.ip': '8.8.8.8'
      })
    })

    it('should not add manual.keep when rate limit is reached', (done) => {
      const addTags = span.addTags
      const params = {}

      expect(Reporter.reportAttack('', params)).to.not.be.false
      expect(addTags.getCall(0).firstArg).to.have.property('manual.keep').that.equals('true')
      expect(Reporter.reportAttack('', params)).to.not.be.false
      expect(addTags.getCall(1).firstArg).to.have.property('manual.keep').that.equals('true')
      expect(Reporter.reportAttack('', params)).to.not.be.false
      expect(addTags.getCall(2).firstArg).to.have.property('manual.keep').that.equals('true')

      Reporter.setRateLimit(1)

      expect(Reporter.reportAttack('', params)).to.not.be.false
      expect(addTags.getCall(3).firstArg).to.have.property('appsec.event').that.equals('true')
      expect(addTags.getCall(3).firstArg).to.have.property('manual.keep').that.equals('true')
      expect(Reporter.reportAttack('', params)).to.not.be.false
      expect(addTags.getCall(4).firstArg).to.have.property('appsec.event').that.equals('true')
      expect(addTags.getCall(4).firstArg).to.not.have.property('manual.keep')

      setTimeout(() => {
        expect(Reporter.reportAttack('', params)).to.not.be.false
        expect(addTags.getCall(5).firstArg).to.have.property('manual.keep').that.equals('true')
        done()
      }, 1e3)
    })

    it('should not overwrite origin tag', () => {
      span.context()._tags = { '_dd.origin': 'tracer' }

      const result = Reporter.reportAttack('[]', {})
      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'http.request.headers.host': 'localhost',
        'http.request.headers.user-agent': 'arachni',
        'appsec.event': 'true',
        'manual.keep': 'true',
        '_dd.appsec.json': '{"triggers":[]}',
        'http.useragent': 'arachni',
        'network.client.ip': '8.8.8.8'
      })
    })

    it('should merge attacks json', () => {
      span.context()._tags = { '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]}]}' }

      const result = Reporter.reportAttack('[{"rule":{}},{"rule":{},"rule_matches":[{}]}]')
      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'http.request.headers.host': 'localhost',
        'http.request.headers.user-agent': 'arachni',
        'appsec.event': 'true',
        'manual.keep': 'true',
        '_dd.origin': 'appsec',
        '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]},{"rule":{}},{"rule":{},"rule_matches":[{}]}]}',
        'http.useragent': 'arachni',
        'network.client.ip': '8.8.8.8'
      })
    })

    it('should add _dd.p.appsec tag if standalone ASM enabled', () => {
      isStandaloneEnabled.returns(true)

      span.context()._tags = { '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]}]}' }

      const result = Reporter.reportAttack('[{"rule":{}},{"rule":{},"rule_matches":[{}]}]')
      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'http.request.headers.host': 'localhost',
        'http.request.headers.user-agent': 'arachni',
        'appsec.event': 'true',
        'manual.keep': 'true',
        '_dd.p.appsec': 1,
        '_dd.origin': 'appsec',
        '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]},{"rule":{}},{"rule":{},"rule_matches":[{}]}]}',
        'http.useragent': 'arachni',
        'network.client.ip': '8.8.8.8'
      })
    })
  })

  describe('reportWafUpdate', () => {
    it('should call incrementWafUpdatesMetric', () => {
      Reporter.reportWafUpdate('0.0.1', '0.0.2')

      expect(telemetry.incrementWafUpdatesMetric).to.have.been.calledOnceWithExactly('0.0.1', '0.0.2')
    })
  })

  describe('reportSchemas', () => {
    it('should not call addTags if parameter is undefined', () => {
      Reporter.reportSchemas(undefined)
      expect(span.addTags).not.to.be.called
    })

    it('should call addTags with an empty array', () => {
      Reporter.reportSchemas([])
      expect(span.addTags).to.be.calledOnceWithExactly({})
    })

    it('should call addTags', () => {
      const schemaValue = [{ key: [8] }]
      const derivatives = {
        '_dd.appsec.s.req.headers': schemaValue,
        '_dd.appsec.s.req.query': schemaValue,
        '_dd.appsec.s.req.params': schemaValue,
        '_dd.appsec.s.req.cookies': schemaValue,
        '_dd.appsec.s.req.body': schemaValue,
        'custom.processor.output': schemaValue
      }

      Reporter.reportSchemas(derivatives)

      const schemaEncoded = zlib.gzipSync(JSON.stringify(schemaValue)).toString('base64')
      expect(span.addTags).to.be.calledOnceWithExactly({
        '_dd.appsec.s.req.headers': schemaEncoded,
        '_dd.appsec.s.req.query': schemaEncoded,
        '_dd.appsec.s.req.params': schemaEncoded,
        '_dd.appsec.s.req.cookies': schemaEncoded,
        '_dd.appsec.s.req.body': schemaEncoded,
        'custom.processor.output': schemaEncoded
      })
    })
  })

  describe('finishRequest', () => {
    let wafContext

    beforeEach(() => {
      wafContext = {
        dispose: sinon.stub()
      }
    })

    afterEach(() => {
      sinon.restore()
    })

    it('should do nothing when passed incomplete objects', () => {
      span.context()._tags['appsec.event'] = 'true'

      web.root.withArgs(null).returns(null)
      web.root.withArgs({}).returns(span)

      Reporter.finishRequest(null, null)
      expect(span.addTags).not.to.have.been.called
    })

    it('should add metrics tags from metricsQueue', () => {
      const req = {}

      Reporter.metricsQueue.set('a', 1)
      Reporter.metricsQueue.set('b', 2)

      Reporter.finishRequest(req, wafContext, {})

      expect(web.root).to.have.been.calledOnceWithExactly(req)
      expect(span.addTags).to.have.been.calledWithExactly({ a: 1, b: 2 })
      expect(Reporter.metricsQueue).to.be.empty
    })

    it('should only add identification headers when no attack was previously found', () => {
      const req = {
        headers: {
          'not-included': 'hello',
          'x-amzn-trace-id': 'a',
          'cloudfront-viewer-ja3-fingerprint': 'b',
          'cf-ray': 'c',
          'x-cloud-trace-context': 'd',
          'x-appgw-trace-id': 'e',
          'x-sigsci-requestid': 'f',
          'x-sigsci-tags': 'g',
          'akamai-user-risk': 'h'
        }
      }

      Reporter.finishRequest(req)
      expect(web.root).to.have.been.calledOnceWith(req)
      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'http.request.headers.x-amzn-trace-id': 'a',
        'http.request.headers.cloudfront-viewer-ja3-fingerprint': 'b',
        'http.request.headers.cf-ray': 'c',
        'http.request.headers.x-cloud-trace-context': 'd',
        'http.request.headers.x-appgw-trace-id': 'e',
        'http.request.headers.x-sigsci-requestid': 'f',
        'http.request.headers.x-sigsci-tags': 'g',
        'http.request.headers.akamai-user-risk': 'h'
      })
    })

    it('should add http response data inside request span', () => {
      const req = {
        route: {
          path: '/path/:param'
        },
        headers: {
          'x-cloud-trace-context': 'd'
        }
      }

      const res = {
        getHeaders: () => {
          return {
            'content-type': 'application/json',
            'content-length': '42'
          }
        }
      }

      span.context()._tags['appsec.event'] = 'true'

      Reporter.finishRequest(req, res)
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledTwice
      expect(span.addTags.firstCall).to.have.been.calledWithExactly({
        'http.request.headers.x-cloud-trace-context': 'd'
      })
      expect(span.addTags.secondCall).to.have.been.calledWithExactly({
        'http.response.headers.content-type': 'application/json',
        'http.response.headers.content-length': '42',
        'http.endpoint': '/path/:param'
      })
    })

    it('should add http response data inside request span without endpoint', () => {
      const req = {}
      const res = {
        getHeaders: () => {
          return {
            'content-type': 'application/json',
            'content-length': '42'
          }
        }
      }

      span.context()._tags['appsec.event'] = 'true'

      Reporter.finishRequest(req, res)
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledWithExactly({
        'http.response.headers.content-type': 'application/json',
        'http.response.headers.content-length': '42'
      })
    })

    it('should call incrementWafRequestsMetric', () => {
      const req = {}
      const res = {}
      Reporter.finishRequest(req, res)

      expect(telemetry.incrementWafRequestsMetric).to.be.calledOnceWithExactly(req)
    })

    it('should set waf.duration tags if there are metrics stored', () => {
      telemetry.getRequestMetrics.returns({ duration: 1337, durationExt: 42 })

      Reporter.finishRequest({}, {})

      expect(span.setTag).to.have.been.calledWithExactly('_dd.appsec.waf.duration', 1337)
      expect(span.setTag).to.have.been.calledWithExactly('_dd.appsec.waf.duration_ext', 42)
    })
  })
})
