'use strict'

const { expect } = require('chai')
const { WafMetric, WafMetricTag } = require('../../../src/appsec/metrics/waf_metric')
const { Scope, Metric } = require('../../../src/appsec/telemetry/metric')
const { CompositeTaggedHandler } = require('../../../src/appsec/telemetry/handlers')
const { AggregatedCombiner, ConflatedCombiner } = require('../../../src/appsec/telemetry/combiners')

describe('WAF metrics and tags', () => {
  describe('WafMetric', () => {
    it('should extend Metric with GLOBAL scope and tagged', () => {
      const wafMetric = new WafMetric('waf.metric')

      expect(wafMetric.scope).to.equal(Scope.GLOBAL)
      expect(wafMetric.type).to.equal('count')
      expect(wafMetric.namespace).to.equal('appsec')
      expect(wafMetric.isTagged()).to.be.true
      expect(wafMetric instanceof Metric).to.be.true
    })

    it('should invoke the toArray method of the composite tag', () => {
      const wafMetric = new WafMetric('waf.metric')
      const compositeTag = {
        toArray: () => ['compositeKey']
      }
      expect(wafMetric.getTags(compositeTag)).to.deep.eq(['compositeKey'])
    })

    it('should call Metric.getTags and return undefined if the composite tag does not have a toArray method', () => {
      const wafMetric = new WafMetric('waf.metric')
      const wrongCompositeTag = {
        missingToArray: () => ['compositeKey']
      }
      expect(wafMetric.getTags(wrongCompositeTag)).to.be.undefined
    })

    it('should call Metric.getTags if the composite tag does not have a toArray method', () => {
      const wafMetric = new WafMetric('waf.metric')
      wafMetric.metricTag = 'appsec'
      expect(wafMetric.getTags('wrong_tag')).to.deep.eq(['appsec:wrong_tag'])
    })

    it('should return a CompositeTaggedHandler', () => {
      const wafMetric = new WafMetric('waf.metric')

      const aggregated = wafMetric.aggregated()
      expect(aggregated instanceof CompositeTaggedHandler).to.be.true
      expect(aggregated.supplier() instanceof AggregatedCombiner)

      const conflated = wafMetric.conflated()
      expect(conflated instanceof CompositeTaggedHandler).to.be.true
      expect(aggregated.supplier() instanceof ConflatedCombiner)
    })
  })

  describe('WafMetricTag', () => {
    const wafVersion = '0.0.1'
    const eventRulesVersion = '0.0.2'

    const onlyVersions = [`event_rules_version:${eventRulesVersion}`, `waf_version:${wafVersion}`]
    const defaultVersions = [`event_rules_version:${eventRulesVersion}`, 'request_blocked:false',
      'rule_triggered:false', 'waf_timeout:false', `waf_version:${wafVersion}`]

    function getKey (requestBlocked, ruleTriggered, wafTimeout) {
      return `event_rules_version:${eventRulesVersion},\
request_blocked:${requestBlocked},rule_triggered:${ruleTriggered},waf_timeout:${wafTimeout},waf_version:${wafVersion}`
    }

    it('should provide a method to create a tag with only wafVersion and eventRulesVersion', () => {
      const tag = WafMetricTag.onlyVersions(wafVersion, eventRulesVersion)

      expect(tag.toArray()).to.deep.eq(onlyVersions)
      expect(tag.key()).to.equal(`event_rules_version:${eventRulesVersion},waf_version:${wafVersion}`)
    })

    it('should provide a method to create a default tag for Waf events', () => {
      const tag = WafMetricTag.default(wafVersion, eventRulesVersion)

      expect(tag.toArray()).to.deep.eq(defaultVersions)
      expect(tag.key()).to.equal(getKey(false, false, false))
    })

    it('should provide a method to change a tag property value', () => {
      const tag = WafMetricTag.default(wafVersion, eventRulesVersion)

      tag.requestBlocked(true).ruleTriggered(true).wafTimeout(true)

      expect(tag.key()).to.equal(getKey(true, true, true))
    })

    it('should discard undefined tag property value', () => {
      const tag = WafMetricTag.default(wafVersion, eventRulesVersion)

      tag.requestBlocked(undefined)

      expect(tag.key()).to.equal(getKey(false, false, false))
    })
  })
})
