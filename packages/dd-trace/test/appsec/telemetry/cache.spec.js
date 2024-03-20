'use strict'

const telemetryMetrics = require('../../../src/telemetry/metrics')
const cache = require('../../../src/appsec/telemetry/cache')
const {
  EVENT_RULES_VERSION,
  REQUEST_BLOCKED,
  RULE_TRIGGERED,
  WAF_TIMEOUT
} = require('../../../src/appsec/telemetry/tags')

const appsecNamespace = telemetryMetrics.manager.namespace('appsec')

describe('Appsec Telemetry metrics cache', () => {
  let tags, count, distribution

  beforeEach(() => {
    tags = { [EVENT_RULES_VERSION]: '0.0.1' }

    count = sinon.stub(appsecNamespace, 'count').callThrough()
    distribution = sinon.stub(appsecNamespace, 'distribution').callThrough()

    appsecNamespace.metrics.clear()
    appsecNamespace.distributions.clear()
  })

  afterEach(() => {
    cache.clearCache()
    sinon.restore()
  })

  describe('getMetric', () => {
    it('should do nothing if EVENT_RULES_VERSION tag is not provided', () => {
      expect(cache.getMetric('metric.name')).to.be.undefined
    })

    it('should return a metric of count type by default', () => {
      cache.getMetric('metric.name', tags)
      expect(count).to.be.calledOnceWith('metric.name')
    })

    it('should return a a metric of distribution type if specified', () => {
      cache.getMetric('metric.name', tags, 'distribution')
      expect(distribution).to.be.calledOnceWith('metric.name')
    })

    it('should use the cache to store created metrics', () => {
      const metric1 = cache.getMetric('metric.name', tags)
      const metric2 = cache.getMetric('metric.name', tags)

      expect(count).to.be.calledOnceWith('metric.name')
      expect(metric1).to.be.eq(metric2)
    })

    it('should clear the cache if new EVENT_RULES_VERSION tag is provided', () => {
      const metric1 = cache.getMetric('metric.name', tags)

      const metric2 = cache.getMetric('metric.name', { [EVENT_RULES_VERSION]: '0.0.2' })

      expect(count).to.be.calledTwice
      expect(metric1).to.not.eq(metric2)
    })

    describe('with waf.requests', () => {
      it('should use the same cached metric for same tags', () => {
        const metric1 = cache.getMetric('waf.requests', { [WAF_TIMEOUT]: false, ...tags })

        const metric2 = cache.getMetric('waf.requests', { [WAF_TIMEOUT]: false, ...tags })

        expect(metric1).to.be.eq(metric2)
      })

      it('should use different cached metrics for different tags', () => {
        const metric1 = cache.getMetric('waf.requests', { [REQUEST_BLOCKED]: true, ...tags })

        const metric2 = cache.getMetric('waf.requests', { [RULE_TRIGGERED]: true, ...tags })

        expect(metric1).to.be.not.eq(metric2)
      })
    })
  })
})
