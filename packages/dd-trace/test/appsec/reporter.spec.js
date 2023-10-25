'use strict'

const proxyquire = require('proxyquire')
const { storage } = require('../../../datadog-core')

describe('reporter', () => {
  let Reporter
  let span
  let web
  let telemetry

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
      incrementWafRequestsMetric: sinon.stub()
    }

    Reporter = proxyquire('../../src/appsec/reporter', {
      '../plugins/util/web': web,
      './telemetry': telemetry
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
      }, [
        'host',
        'user-agent',
        'x-forwarded-for',
        'x-client-ip'
      ], 'prefix.')

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
      Reporter.reportMetrics({ duration: 1337 })

      expect(web.root).to.have.been.calledOnceWithExactly(req)
      expect(span.setTag).to.have.been.calledOnceWithExactly('_dd.appsec.waf.duration', 1337)
    })

    it('should set ext duration metrics if set', () => {
      Reporter.reportMetrics({ durationExt: 42 })

      expect(web.root).to.have.been.calledOnceWithExactly(req)
      expect(span.setTag).to.have.been.calledOnceWithExactly('_dd.appsec.waf.duration_ext', 42)
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
  })

  describe('reportWafUpdate', () => {
    it('should call incrementWafUpdatesMetric', () => {
      Reporter.reportWafUpdate('0.0.1', '0.0.2')

      expect(telemetry.incrementWafUpdatesMetric).to.have.been.calledOnceWithExactly('0.0.1', '0.0.2')
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
      expect(span.addTags).to.have.been.calledOnceWithExactly({ a: 1, b: 2 })
      expect(Reporter.metricsQueue).to.be.empty
    })

    it('should not add http response data when no attack was previously found', () => {
      const req = {}

      Reporter.finishRequest(req)
      expect(web.root).to.have.been.calledOnceWith(req)
      expect(span.addTags).to.not.have.been.called
    })

    it('should add http response data inside request span', () => {
      const req = {
        route: {
          path: '/path/:param'
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

      expect(span.addTags).to.have.been.calledOnceWithExactly({
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

      expect(span.addTags).to.have.been.calledOnceWithExactly({
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
  })
})
