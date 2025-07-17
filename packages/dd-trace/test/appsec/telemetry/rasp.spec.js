'use strict'

const telemetryMetrics = require('../../../src/telemetry/metrics')
const appsecNamespace = telemetryMetrics.manager.namespace('appsec')

const appsecTelemetry = require('../../../src/appsec/telemetry')
const Config = require('../../../src/config')

describe('Appsec Rasp Telemetry metrics', () => {
  const wafVersion = '0.0.1'
  const rulesVersion = '0.0.2'

  let count, inc, req

  beforeEach(() => {
    req = {}

    inc = sinon.spy()
    count = sinon.stub(appsecNamespace, 'count').returns({
      inc
    })

    appsecNamespace.metrics.clear()
  })

  afterEach(sinon.restore)

  describe('if enabled', () => {
    beforeEach(() => {
      const config = new Config()
      config.telemetry.enabled = true
      config.telemetry.metrics = true

      appsecTelemetry.enable(config)
    })

    describe('updateRaspRequestsMetricTags', () => {
      it('should increment rasp.rule.eval metric', () => {
        appsecTelemetry.updateRaspRequestsMetricTags({
          duration: 42,
          durationExt: 52,
          wafVersion: '1.0.0',
          rulesVersion: '2.0.0'
        }, req, { type: 'rule-type' })

        expect(count).to.have.been.calledWith('rasp.rule.eval', {
          rule_type: 'rule-type',
          waf_version: '1.0.0',
          event_rules_version: '2.0.0'
        })
        expect(count).to.not.have.been.calledWith('rasp.timeout', {
          rule_type: 'rule-type',
          waf_version: '1.0.0',
          event_rules_version: '2.0.0'
        })
        expect(count).to.not.have.been.calledWith('rasp.rule.match')
        expect(inc).to.have.been.calledOnceWith(1)
      })

      it('should increment rasp.timeout metric if timeout', () => {
        appsecTelemetry.updateRaspRequestsMetricTags({
          duration: 42,
          durationExt: 52,
          wafTimeout: true,
          wafVersion: '1.0.0',
          rulesVersion: '2.0.0'
        }, req, { type: 'rule-type' })

        expect(count).to.have.been.calledWith('rasp.rule.eval', {
          rule_type: 'rule-type',
          waf_version: '1.0.0',
          event_rules_version: '2.0.0'
        })
        expect(count).to.have.been.calledWith('rasp.timeout', {
          rule_type: 'rule-type',
          waf_version: '1.0.0',
          event_rules_version: '2.0.0'
        })
        expect(count).to.not.have.been.calledWith('rasp.rule.match')
        expect(inc).to.have.been.calledTwice
      })

      it('should track rasp.error', () => {
        appsecTelemetry.updateRaspRequestsMetricTags({
          errorCode: -127,
          wafVersion: '1.0.0',
          rulesVersion: '2.0.0'
        }, req, { type: 'rule-type' })

        expect(count).to.have.been.calledWith('rasp.error', {
          waf_version: '1.0.0',
          event_rules_version: '2.0.0',
          rule_type: 'rule-type',
          waf_error: -127
        })

        appsecTelemetry.updateRaspRequestsMetricTags({
          errorCode: -2,
          wafVersion: '1.0.0',
          rulesVersion: '2.0.0'
        }, req, { type: 'rule-type' })

        expect(count).to.have.been.calledWith('rasp.error', {
          waf_version: '1.0.0',
          event_rules_version: '2.0.0',
          rule_type: 'rule-type',
          waf_error: -2
        })
      })

      it('should sum rasp.duration and eval metrics', () => {
        appsecTelemetry.updateRaspRequestsMetricTags({
          duration: 42,
          durationExt: 52
        }, req, { type: 'rule-type' })

        appsecTelemetry.updateRaspRequestsMetricTags({
          duration: 24,
          durationExt: 25
        }, req, { type: 'rule-type' })

        const {
          duration,
          durationExt,
          raspDuration,
          raspDurationExt,
          raspEvalCount
        } = appsecTelemetry.getRequestMetrics(req)

        expect(duration).to.be.eq(0)
        expect(durationExt).to.be.eq(0)
        expect(raspDuration).to.be.eq(66)
        expect(raspDurationExt).to.be.eq(77)
        expect(raspEvalCount).to.be.eq(2)
      })

      it('should increment raspTimeouts if wafTimeout is true', () => {
        appsecTelemetry.updateRaspRequestsMetricTags({ wafTimeout: true }, req, { type: 'rule-type' })
        appsecTelemetry.updateRaspRequestsMetricTags({ wafTimeout: true }, req, { type: 'rule-type' })

        const { raspTimeouts } = appsecTelemetry.getRequestMetrics(req)
        expect(raspTimeouts).to.equal(2)
      })

      it('should keep the maximum raspErrorCode', () => {
        appsecTelemetry.updateRaspRequestsMetricTags({ errorCode: -1 }, req, { type: 'rule-type' })
        appsecTelemetry.updateRaspRequestsMetricTags({ errorCode: -3 }, req, { type: 'rule-type' })

        const { raspErrorCode } = appsecTelemetry.getRequestMetrics(req)
        expect(raspErrorCode).to.equal(-1)
      })
    })

    describe('updateRaspRuleMatchMetricTags', () => {
      const raspRule = { type: 'rule-type', variant: 'rule-variant' }

      beforeEach(() => {
        req = {}
        appsecTelemetry.updateRaspRequestsMetricTags({
          ruleTriggered: true,
          wafVersion: '1.0.0',
          rulesVersion: '2.0.0'
        }, req, { type: 'rule-type' })

        count.resetHistory()
        inc.resetHistory()
      })

      it('should increment rasp.rule.match metric with success block status', () => {
        appsecTelemetry.updateRaspRuleMatchMetricTags(req, raspRule, true, true)

        expect(count).to.have.been.calledWith('rasp.rule.match', {
          rule_type: 'rule-type',
          rule_variant: 'rule-variant',
          waf_version: '1.0.0',
          event_rules_version: '2.0.0',
          block: 'success'
        })
        expect(inc).to.have.been.called
      })

      it('should increment rasp.rule.match metric with failure block status', () => {
        appsecTelemetry.updateRaspRuleMatchMetricTags(req, raspRule, true, false)

        expect(count).to.have.been.calledWith('rasp.rule.match', {
          rule_type: 'rule-type',
          rule_variant: 'rule-variant',
          waf_version: '1.0.0',
          event_rules_version: '2.0.0',
          block: 'failure'
        })
        expect(inc).to.have.been.called
      })

      it('should increment rasp.rule.match metric with irrelevant block status', () => {
        appsecTelemetry.updateRaspRuleMatchMetricTags(req, raspRule, false, false)

        expect(count).to.have.been.calledWith('rasp.rule.match', {
          rule_type: 'rule-type',
          rule_variant: 'rule-variant',
          waf_version: '1.0.0',
          event_rules_version: '2.0.0',
          block: 'irrelevant'
        })
        expect(inc).to.have.been.called
      })

      it('should not increment any metric if req is not provided', () => {
        appsecTelemetry.updateRaspRuleMatchMetricTags(null, raspRule, true, true)

        expect(count).to.not.have.been.called
        expect(inc).to.not.have.been.called
      })
    })

    describe('updateRaspRuleSkippedMetricTags', () => {
      it('should increment rasp.rule.skipped with reason', () => {
        const raspRule = { type: 'rule-type', variant: 'rule-variant' }
        appsecTelemetry.updateRaspRuleSkippedMetricTags(raspRule, 'after-request')

        expect(count).to.have.been.calledWith('rasp.rule.skipped', {
          reason: 'after-request',
          rule_type: 'rule-type',
          rule_variant: 'rule-variant'
        })
      })
    })

    describe('incWafRequestsMetric', () => {
      it('should not modify waf.requests metric tags when rasp rule type is provided', () => {
        appsecTelemetry.updateWafRequestsMetricTags({
          blockTriggered: false,
          ruleTriggered: false,
          wafTimeout: false,
          wafVersion,
          rulesVersion
        }, req)

        appsecTelemetry.updateRaspRequestsMetricTags({
          blockTriggered: true,
          ruleTriggered: true,
          wafTimeout: true,
          input_truncated: true,
          wafVersion,
          rulesVersion
        }, req, { type: 'rule-type' })

        expect(count).to.have.not.been.calledWith('waf.requests')
        appsecTelemetry.incrementWafRequestsMetric(req)

        expect(count).to.have.been.calledWithExactly('waf.requests', {
          block_failure: false,
          input_truncated: false,
          request_blocked: false,
          rate_limited: false,
          rule_triggered: false,
          waf_error: false,
          waf_timeout: false,
          waf_version: wafVersion,
          event_rules_version: rulesVersion
        })
      })
    })
  })

  describe('if disabled', () => {
    it('should not increment any metric if telemetry is disabled', () => {
      appsecTelemetry.enable({
        enabled: false,
        metrics: true
      })

      appsecTelemetry.incrementWafInitMetric(wafVersion, rulesVersion)

      expect(count).to.not.have.been.called
      expect(inc).to.not.have.been.called
    })

    it('should not increment any metric if telemetry metrics are disabled', () => {
      appsecTelemetry.enable({
        enabled: true,
        metrics: false
      })

      appsecTelemetry.incrementWafInitMetric(wafVersion, rulesVersion)

      expect(count).to.not.have.been.called
      expect(inc).to.not.have.been.called
    })

    describe('updateRaspRequestsMetricTags', () => {
      it('should sum rasp.duration and rasp.durationExt request metrics', () => {
        appsecTelemetry.enable({
          enabled: false,
          metrics: true
        })

        appsecTelemetry.updateRaspRequestsMetricTags({
          duration: 42,
          durationExt: 52
        }, req, 'rasp_rule')

        appsecTelemetry.updateRaspRequestsMetricTags({
          duration: 24,
          durationExt: 25
        }, req, 'rasp_rule')

        const { raspDuration, raspDurationExt, raspEvalCount } = appsecTelemetry.getRequestMetrics(req)

        expect(raspDuration).to.be.eq(66)
        expect(raspDurationExt).to.be.eq(77)
        expect(raspEvalCount).to.be.eq(2)
      })

      it('should sum rasp.duration and rasp.durationExt with telemetry enabled and metrics disabled', () => {
        appsecTelemetry.enable({
          enabled: true,
          metrics: false
        })

        appsecTelemetry.updateRaspRequestsMetricTags({
          duration: 42,
          durationExt: 52
        }, req, { type: 'rule-type' })

        appsecTelemetry.updateRaspRequestsMetricTags({
          duration: 24,
          durationExt: 25
        }, req, { type: 'rule-type' })

        const { raspDuration, raspDurationExt, raspEvalCount } = appsecTelemetry.getRequestMetrics(req)

        expect(raspDuration).to.be.eq(66)
        expect(raspDurationExt).to.be.eq(77)
        expect(raspEvalCount).to.be.eq(2)
      })

      it('should not increment any metric if telemetry metrics are disabled', () => {
        appsecTelemetry.enable({
          enabled: true,
          metrics: false
        })

        appsecTelemetry.updateRaspRequestsMetricTags({
          duration: 24,
          durationExt: 25
        }, req, { type: 'rule-type' })

        expect(count).to.not.have.been.called
        expect(inc).to.not.have.been.called
      })
    })
  })
})
