'use strict'

const proxyquire = require('proxyquire')
const { storage } = require('../../../datadog-core')
const zlib = require('zlib')
const { SAMPLING_MECHANISM_APPSEC } = require('../../src/constants')
const { USER_KEEP } = require('../../../../ext/priority')

describe('reporter', () => {
  let Reporter
  let span
  let web
  let telemetry
  let sample
  let prioritySampler

  beforeEach(() => {
    prioritySampler = {
      setPriority: sinon.stub()
    }

    span = {
      _prioritySampler: prioritySampler,
      context: sinon.stub().returns({
        _tags: {}
      }),
      addTags: sinon.stub(),
      setTag: sinon.stub(),
      keep: sinon.stub()
    }

    web = {
      root: sinon.stub().returns(span)
    }

    telemetry = {
      incrementWafInitMetric: sinon.stub(),
      updateWafRequestsMetricTags: sinon.stub(),
      updateRaspRequestsMetricTags: sinon.stub(),
      incrementWafUpdatesMetric: sinon.stub(),
      incrementWafRequestsMetric: sinon.stub(),
      getRequestMetrics: sinon.stub()
    }

    sample = sinon.stub()

    Reporter = proxyquire('../../src/appsec/reporter', {
      '../plugins/util/web': web,
      './telemetry': telemetry,
      './standalone': {
        sample
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
  })

  describe('reportMetrics', () => {
    let req

    beforeEach(() => {
      req = {}
      storage('legacy').enterWith({ req })
    })

    afterEach(() => {
      storage('legacy').disable()
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
      expect(telemetry.updateRaspRequestsMetricTags).to.not.have.been.called
    })

    it('should set ext duration metrics if set', () => {
      const metrics = { durationExt: 42 }
      Reporter.reportMetrics(metrics)

      expect(web.root).to.have.been.calledOnceWithExactly(req)
      expect(telemetry.updateWafRequestsMetricTags).to.have.been.calledOnceWithExactly(metrics, req)
      expect(telemetry.updateRaspRequestsMetricTags).to.not.have.been.called
    })

    it('should set rulesVersion if set', () => {
      Reporter.reportMetrics({ rulesVersion: '1.2.3' })

      expect(web.root).to.have.been.calledOnceWithExactly(req)
      expect(span.setTag).to.have.been.calledOnceWithExactly('_dd.appsec.event_rules.version', '1.2.3')
      expect(telemetry.updateRaspRequestsMetricTags).to.not.have.been.called
    })

    it('should call updateWafRequestsMetricTags', () => {
      const metrics = { rulesVersion: '1.2.3' }
      const store = storage('legacy').getStore()

      Reporter.reportMetrics(metrics)

      expect(telemetry.updateWafRequestsMetricTags).to.have.been.calledOnceWithExactly(metrics, store.req)
      expect(telemetry.updateRaspRequestsMetricTags).to.not.have.been.called
    })

    it('should call updateRaspRequestsMetricTags when raspRule is provided', () => {
      const metrics = { rulesVersion: '1.2.3' }
      const store = storage('legacy').getStore()

      const raspRule = { type: 'rule_type', variant: 'rule_variant' }

      Reporter.reportMetrics(metrics, raspRule)

      expect(telemetry.updateRaspRequestsMetricTags).to.have.been.calledOnceWithExactly(metrics, store.req, raspRule)
      expect(telemetry.updateWafRequestsMetricTags).to.not.have.been.called
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
      storage('legacy').enterWith({ req })
    })

    afterEach(() => {
      storage('legacy').disable()
    })

    it('should add tags to request span when socket is not there', () => {
      delete req.socket

      const result = Reporter.reportAttack('[{"rule":{},"rule_matches":[{}]}]')

      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'appsec.event': 'true',
        '_dd.origin': 'appsec',
        '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]}]}'
      })
      expect(prioritySampler.setPriority).to.have.been.calledOnceWithExactly(span, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
    })

    it('should add tags to request span', () => {
      const result = Reporter.reportAttack('[{"rule":{},"rule_matches":[{}]}]')
      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'appsec.event': 'true',
        '_dd.origin': 'appsec',
        '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]}]}',
        'network.client.ip': '8.8.8.8'
      })
      expect(prioritySampler.setPriority).to.have.been.calledOnceWithExactly(span, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
    })

    it('should not add manual.keep when rate limit is reached', (done) => {
      const addTags = span.addTags
      const params = {}

      expect(Reporter.reportAttack('', params)).to.not.be.false
      expect(Reporter.reportAttack('', params)).to.not.be.false
      expect(Reporter.reportAttack('', params)).to.not.be.false

      expect(prioritySampler.setPriority).to.have.callCount(3)

      Reporter.setRateLimit(1)

      expect(Reporter.reportAttack('', params)).to.not.be.false
      expect(addTags.getCall(3).firstArg).to.have.property('appsec.event').that.equals('true')
      expect(prioritySampler.setPriority).to.have.callCount(4)
      expect(Reporter.reportAttack('', params)).to.not.be.false
      expect(addTags.getCall(4).firstArg).to.have.property('appsec.event').that.equals('true')
      expect(prioritySampler.setPriority).to.have.callCount(4)

      setTimeout(() => {
        expect(Reporter.reportAttack('', params)).to.not.be.false
        expect(prioritySampler.setPriority).to.have.callCount(5)
        done()
      }, 1020)
    })

    it('should not overwrite origin tag', () => {
      span.context()._tags = { '_dd.origin': 'tracer' }

      const result = Reporter.reportAttack('[]', {})
      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'appsec.event': 'true',
        '_dd.appsec.json': '{"triggers":[]}',
        'network.client.ip': '8.8.8.8'
      })
      expect(prioritySampler.setPriority).to.have.been.calledOnceWithExactly(span, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
    })

    it('should merge attacks json', () => {
      span.context()._tags = { '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]}]}' }

      const result = Reporter.reportAttack('[{"rule":{}},{"rule":{},"rule_matches":[{}]}]')
      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'appsec.event': 'true',
        '_dd.origin': 'appsec',
        '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]},{"rule":{}},{"rule":{},"rule_matches":[{}]}]}',
        'network.client.ip': '8.8.8.8'
      })
      expect(prioritySampler.setPriority).to.have.been.calledOnceWithExactly(span, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
    })

    it('should call standalone sample', () => {
      span.context()._tags = { '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]}]}' }

      const result = Reporter.reportAttack('[{"rule":{}},{"rule":{},"rule_matches":[{}]}]')
      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'appsec.event': 'true',
        '_dd.origin': 'appsec',
        '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]},{"rule":{}},{"rule":{},"rule_matches":[{}]}]}',
        'network.client.ip': '8.8.8.8'
      })

      expect(prioritySampler.setPriority).to.have.been.calledOnceWithExactly(span, USER_KEEP, SAMPLING_MECHANISM_APPSEC)

      expect(sample).to.have.been.calledOnceWithExactly(span)
    })
  })

  describe('reportWafUpdate', () => {
    it('should call incrementWafUpdatesMetric', () => {
      Reporter.reportWafUpdate('0.0.1', '0.0.2')

      expect(telemetry.incrementWafUpdatesMetric).to.have.been.calledOnceWithExactly('0.0.1', '0.0.2')
    })
  })

  describe('reportDerivatives', () => {
    it('should not call addTags if parameter is undefined', () => {
      Reporter.reportDerivatives(undefined)
      expect(span.addTags).not.to.be.called
    })

    it('should call addTags with an empty array', () => {
      Reporter.reportDerivatives([])
      expect(span.addTags).to.be.calledOnceWithExactly({})
    })

    it('should call addTags', () => {
      const schemaValue = [{ key: [8] }]
      const derivatives = {
        '_dd.appsec.fp.http.endpoint': 'endpoint_fingerprint',
        '_dd.appsec.fp.http.header': 'header_fingerprint',
        '_dd.appsec.fp.http.network': 'network_fingerprint',
        '_dd.appsec.fp.session': 'session_fingerprint',
        '_dd.appsec.s.req.headers': schemaValue,
        '_dd.appsec.s.req.query': schemaValue,
        '_dd.appsec.s.req.params': schemaValue,
        '_dd.appsec.s.req.cookies': schemaValue,
        '_dd.appsec.s.req.body': schemaValue,
        'custom.processor.output': schemaValue
      }

      Reporter.reportDerivatives(derivatives)

      const schemaEncoded = zlib.gzipSync(JSON.stringify(schemaValue)).toString('base64')
      expect(span.addTags).to.be.calledOnceWithExactly({
        '_dd.appsec.fp.http.endpoint': 'endpoint_fingerprint',
        '_dd.appsec.fp.http.header': 'header_fingerprint',
        '_dd.appsec.fp.http.network': 'network_fingerprint',
        '_dd.appsec.fp.session': 'session_fingerprint',
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

    const requestHeadersToTrackOnEvent = [
      'x-forwarded-for',
      'x-real-ip',
      'true-client-ip',
      'x-client-ip',
      'x-forwarded',
      'forwarded-for',
      'x-cluster-client-ip',
      'fastly-client-ip',
      'cf-connecting-ip',
      'cf-connecting-ipv6',
      'forwarded',
      'via',
      'content-length',
      'content-encoding',
      'content-language',
      'host',
      'accept-encoding',
      'accept-language'
    ]
    const requestHeadersAndValuesToTrackOnEvent = {}
    const expectedRequestTagsToTrackOnEvent = {}
    requestHeadersToTrackOnEvent.forEach((header, index) => {
      requestHeadersAndValuesToTrackOnEvent[header] = `val-${index}`
      expectedRequestTagsToTrackOnEvent[`http.request.headers.${header}`] = `val-${index}`
    })

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

    it('should only add mandatory headers when no attack or event was previously found', () => {
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
          'akamai-user-risk': 'h',
          'content-type': 'i',
          accept: 'j',
          'user-agent': 'k'
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
        'http.request.headers.akamai-user-risk': 'h',
        'http.request.headers.content-type': 'i',
        'http.request.headers.accept': 'j',
        'http.request.headers.user-agent': 'k'
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

    it('should add http request data inside request span when appsec.event is true', () => {
      const req = {
        headers: {
          'user-agent': 'arachni',
          ...requestHeadersAndValuesToTrackOnEvent
        }
      }
      const res = {
        getHeaders: () => {
          return {}
        }
      }
      span.context()._tags['appsec.event'] = 'true'

      Reporter.finishRequest(req, res)

      expect(span.addTags).to.have.been.calledWithExactly({
        'http.request.headers.user-agent': 'arachni'
      })

      expect(span.addTags).to.have.been.calledWithExactly(expectedRequestTagsToTrackOnEvent)
    })

    it('should add http request data inside request span when user login success is tracked', () => {
      const req = {
        headers: {
          'user-agent': 'arachni',
          ...requestHeadersAndValuesToTrackOnEvent
        }
      }
      const res = {
        getHeaders: () => {
          return {}
        }
      }

      span.context()
        ._tags['appsec.events.users.login.success.track'] = 'true'

      Reporter.finishRequest(req, res)

      expect(span.addTags).to.have.been.calledWithExactly({
        'http.request.headers.user-agent': 'arachni'
      })

      expect(span.addTags).to.have.been.calledWithExactly(expectedRequestTagsToTrackOnEvent)
    })

    it('should add http request data inside request span when user login failure is tracked', () => {
      const req = {
        headers: {
          'user-agent': 'arachni',
          ...requestHeadersAndValuesToTrackOnEvent
        }
      }
      const res = {
        getHeaders: () => {
          return {}
        }
      }

      span.context()
        ._tags['appsec.events.users.login.failure.track'] = 'true'

      Reporter.finishRequest(req, res)

      expect(span.addTags).to.have.been.calledWithExactly({
        'http.request.headers.user-agent': 'arachni'
      })

      expect(span.addTags).to.have.been.calledWithExactly(expectedRequestTagsToTrackOnEvent)
    })

    it('should add http request data inside request span when user custom event is tracked', () => {
      const req = {
        headers: {
          'user-agent': 'arachni',
          ...requestHeadersAndValuesToTrackOnEvent
        }
      }
      const res = {
        getHeaders: () => {
          return {}
        }
      }

      span.context()
        ._tags['appsec.events.custon.event.track'] = 'true'

      Reporter.finishRequest(req, res)

      expect(span.addTags).to.have.been.calledWithExactly({
        'http.request.headers.user-agent': 'arachni'
      })

      expect(span.addTags).to.have.been.calledWithExactly(expectedRequestTagsToTrackOnEvent)
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
      expect(span.setTag).to.not.have.been.calledWith('_dd.appsec.rasp.duration')
      expect(span.setTag).to.not.have.been.calledWith('_dd.appsec.rasp.duration_ext')
      expect(span.setTag).to.not.have.been.calledWith('_dd.appsec.rasp.rule.eval')
    })

    it('should set rasp.duration tags if there are metrics stored', () => {
      telemetry.getRequestMetrics.returns({ raspDuration: 123, raspDurationExt: 321, raspEvalCount: 3 })

      Reporter.finishRequest({}, {})

      expect(span.setTag).to.not.have.been.calledWith('_dd.appsec.waf.duration')
      expect(span.setTag).to.not.have.been.calledWith('_dd.appsec.waf.duration_ext')
      expect(span.setTag).to.have.been.calledWithExactly('_dd.appsec.rasp.duration', 123)
      expect(span.setTag).to.have.been.calledWithExactly('_dd.appsec.rasp.duration_ext', 321)
      expect(span.setTag).to.have.been.calledWithExactly('_dd.appsec.rasp.rule.eval', 3)
    })

    it('should keep span if there are metrics', () => {
      const req = {}

      Reporter.metricsQueue.set('a', 1)
      Reporter.metricsQueue.set('b', 2)

      Reporter.finishRequest(req, wafContext, {})

      expect(prioritySampler.setPriority).to.have.been.calledOnceWithExactly(span, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
    })
  })
})
