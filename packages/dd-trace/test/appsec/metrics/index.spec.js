'use strict'

const { expect } = require('chai')

const {
  WAF_DURATION,
  WAF_DURATION_EXT,
  WAF_REQUESTS,
  WAF_INIT,
  WafMetricTag,
  WAF_UPDATES
} = require('../../../src/appsec/metrics/waf_metric')
const telemetry = require('../../../src/appsec/telemetry')
const {
  updateWafResults,
  incWafRequests,
  incWafInitMetric,
  incWafUpdatesMetric,
  DD_TELEMETRY_WAF_RESULT_TAGS
} = require('../../../src/appsec/metrics')

describe('Appsec metrics', () => {
  let store, telemetryMetricsEnabled

  beforeEach(() => {
    store = {}
    telemetryMetricsEnabled = true

    sinon.restore()

    sinon.stub(telemetry, 'isEnabled').callsFake(() => telemetryMetricsEnabled)
    sinon.stub(WAF_DURATION, 'add')
    sinon.stub(WAF_DURATION_EXT, 'add')
  })

  describe('updateWafResults', () => {
    it('should create a default WafMetricTag and store it in the context', () => {
      updateWafResults({
        duration: 1,
        durationExt: 2,
        wafVersion: 'wafVersion',
        rulesVersion: 'eventRulesVersion'
      }, store)

      const wafResultTags = store[DD_TELEMETRY_WAF_RESULT_TAGS]
      expect(wafResultTags).to.not.be.undefined
      expect(wafResultTags instanceof WafMetricTag)
      expect(wafResultTags.tags.get('waf_version')).to.eq('wafVersion')
      expect(wafResultTags.tags.get('event_rules_version')).to.eq('eventRulesVersion')
      expect(wafResultTags.tags.get('rule_triggered')).to.be.false
      expect(wafResultTags.tags.get('request_blocked')).to.be.false
      expect(wafResultTags.tags.get('waf_timeout')).to.be.false
    })

    it('should reuse and update a stored WafMetricTag', () => {
      updateWafResults({
        duration: 1,
        durationExt: 2,
        wafVersion: 'wafVersion',
        rulesVersion: 'eventRulesVersion'
      }, store)

      sinon.stub(WafMetricTag, 'default')

      updateWafResults({
        ruleTriggered: true
      }, store)

      updateWafResults({
        requestBlocked: true
      }, store)

      updateWafResults({
        wafTimeout: true
      }, store)

      expect(WafMetricTag.default).to.not.be.called

      const wafResultTags = store[DD_TELEMETRY_WAF_RESULT_TAGS]
      expect(wafResultTags).to.not.be.undefined
      expect(wafResultTags.tags.get('waf_version')).to.eq('wafVersion')
      expect(wafResultTags.tags.get('event_rules_version')).to.eq('eventRulesVersion')
      expect(wafResultTags.tags.get('rule_triggered')).to.be.true
      expect(wafResultTags.tags.get('request_blocked')).to.be.true
      expect(wafResultTags.tags.get('waf_timeout')).to.be.true
    })

    it('should increment waf duration metrics', () => {
      const onlyVersionsTag = new WafMetricTag().wafVersion('wafVersion')
        .eventRulesVersion('rulesVersion')
      sinon.stub(WafMetricTag, 'onlyVersions').returns(onlyVersionsTag)

      updateWafResults({
        duration: 1,
        durationExt: 2,
        wafVersion: 'wafVersion',
        rulesVersion: 'eventRulesVersion'
      }, store)

      expect(WafMetricTag.onlyVersions).to.be.calledTwice

      expect(WAF_DURATION.add).to.be.calledOnceWithExactly(1, onlyVersionsTag)
      expect(WAF_DURATION_EXT.add).to.be.calledOnceWithExactly(2, onlyVersionsTag)
    })

    it('should not increment metrics if telemetry metrics are disabled', () => {
      telemetryMetricsEnabled = false
      sinon.stub(WafMetricTag, 'default')

      updateWafResults({
        duration: 1,
        durationExt: 2,
        wafVersion: 'wafVersion',
        rulesVersion: 'eventRulesVersion'
      }, store)

      expect(WafMetricTag.default).to.not.be.called
    })

    it('should not increment metrics if there is no context', () => {
      store = undefined
      sinon.stub(WafMetricTag, 'default')

      updateWafResults({
        duration: 1,
        durationExt: 2,
        wafVersion: 'wafVersion',
        rulesVersion: 'eventRulesVersion'
      }, store)

      expect(WafMetricTag.default).to.not.be.called
    })
  })

  describe('incWafInitMetric', () => {
    it('should increase WAF_INIT metric', () => {
      const tag = {}
      sinon.stub(WafMetricTag, 'onlyVersions').returns(tag)
      sinon.stub(WAF_INIT, 'increase')

      incWafInitMetric(store)

      expect(WAF_INIT.increase).to.be.calledOnceWithExactly(tag)
    })
  })

  describe('incWafUpdatesMetric', () => {
    it('should increase WAF_UPDATES metric', () => {
      const tag = {}
      sinon.stub(WafMetricTag, 'onlyVersions').returns(tag)
      sinon.stub(WAF_UPDATES, 'increase')

      incWafUpdatesMetric(store)

      expect(WAF_UPDATES.increase).to.be.calledOnceWithExactly(tag)
    })
  })

  describe('incWafRequests', () => {
    it('should increase WAF_REQUEST metric', () => {
      const tag = {}
      store[DD_TELEMETRY_WAF_RESULT_TAGS] = tag

      sinon.stub(WAF_REQUESTS, 'increase')

      incWafRequests(store)

      expect(WAF_REQUESTS.increase).to.be.calledOnceWithExactly(tag)
    })

    it('should not increase WAF_REQUEST metric if there is no tag in the context', () => {
      sinon.stub(WAF_REQUESTS, 'increase')

      incWafRequests(store)

      expect(WAF_REQUESTS.increase).to.not.be.called
    })
  })
})
