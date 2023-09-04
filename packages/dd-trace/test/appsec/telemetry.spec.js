'use strict'

const telemetryMetrics = require('../../src/telemetry/metrics')
const appsecNamespace = telemetryMetrics.manager.namespace('appsec')

const appsecTelemetry = require('../../src/appsec/telemetry')

describe('Appsec Telemetry metrics', () => {
  const wafVersion = '0.0.1'
  const rulesVersion = '0.0.2'

  let count, distribution, inc, track, req

  beforeEach(() => {
    req = {}

    inc = sinon.spy()
    track = sinon.spy()
    count = sinon.stub(appsecNamespace, 'count').returns({
      inc
    })
    distribution = sinon.stub(appsecNamespace, 'distribution').returns({
      track
    })

    appsecNamespace.metrics.clear()
    appsecNamespace.distributions.clear()
  })

  afterEach(sinon.restore)

  describe('if enabled', () => {
    beforeEach(() => {
      appsecTelemetry.enable({
        enabled: true,
        metrics: true
      })
    })

    describe('updateWafRequestsMetricTags', () => {
      const metrics = {
        wafVersion,
        rulesVersion
      }

      it('should skip update if no request is provided', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags(metrics)

        expect(result).to.be.undefined
      })

      it('should create a default tag', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags(metrics, req)

        expect(result).to.be.deep.eq({
          waf_version: wafVersion,
          event_rules_version: rulesVersion,
          request_blocked: false,
          rule_triggered: false,
          waf_timeout: false
        })
      })

      it('should create a tag with custom values', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags({
          blockTriggered: true,
          ruleTriggered: true,
          wafTimeout: true,
          ...metrics
        }, req)

        expect(result).to.be.deep.eq({
          waf_version: wafVersion,
          event_rules_version: rulesVersion,
          request_blocked: true,
          rule_triggered: true,
          waf_timeout: true
        })
      })

      it('should update existing tag ', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags(metrics, req)

        const result2 = appsecTelemetry.updateWafRequestsMetricTags({
          ruleTriggered: true,
          ...metrics
        }, req)

        expect(result).to.be.eq(result2)

        expect(result).to.be.deep.eq({
          waf_version: wafVersion,
          event_rules_version: rulesVersion,
          request_blocked: false,
          rule_triggered: true,
          waf_timeout: false
        })
      })

      it('should handle different requests tags ', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags({
          blockTriggered: true,
          ruleTriggered: true,
          wafTimeout: true,
          ...metrics
        }, req)

        const req2 = {}
        const result2 = appsecTelemetry.updateWafRequestsMetricTags({
          blockTriggered: false,
          ruleTriggered: false,
          wafTimeout: false,
          ...metrics
        }, req2)

        expect(result).to.be.not.eq(result2)

        expect(result).to.be.deep.eq({
          waf_version: wafVersion,
          event_rules_version: rulesVersion,
          request_blocked: true,
          rule_triggered: true,
          waf_timeout: true
        })
      })

      it('should call trackWafDurations', () => {
        appsecTelemetry.updateWafRequestsMetricTags({
          duration: 42,
          durationExt: 52,
          ...metrics
        }, req)

        expect(distribution).to.have.been.calledTwice

        const tag = {
          waf_version: wafVersion,
          event_rules_version: rulesVersion
        }
        expect(distribution.firstCall.args).to.be.deep.eq(['waf.duration', tag])
        expect(distribution.secondCall.args).to.be.deep.eq(['waf.duration_ext', tag])

        expect(track).to.have.been.calledTwice
      })
    })

    describe('incWafInitMetric', () => {
      it('should increment waf.init metric', () => {
        appsecTelemetry.incrementWafInitMetric(wafVersion, rulesVersion)

        expect(count).to.have.been.calledOnceWithExactly('waf.init', {
          waf_version: wafVersion,
          event_rules_version: rulesVersion
        })
        expect(inc).to.have.been.calledOnce
      })

      it('should increment waf.init metric multiple times', () => {
        sinon.restore()

        appsecTelemetry.incrementWafInitMetric(wafVersion, rulesVersion)
        appsecTelemetry.incrementWafInitMetric(wafVersion, rulesVersion)
        appsecTelemetry.incrementWafInitMetric(wafVersion, rulesVersion)

        const { metrics } = appsecNamespace.toJSON()
        expect(metrics.series.length).to.be.eq(1)
        expect(metrics.series[0].metric).to.be.eq('waf.init')
        expect(metrics.series[0].points.length).to.be.eq(1)
        expect(metrics.series[0].points[0][1]).to.be.eq(3)
        expect(metrics.series[0].tags).to.include('waf_version:0.0.1')
        expect(metrics.series[0].tags).to.include('event_rules_version:0.0.2')
      })
    })

    describe('incWafUpdatesMetric', () => {
      it('should increment waf.updates metric', () => {
        appsecTelemetry.incrementWafUpdatesMetric(wafVersion, rulesVersion)

        expect(count).to.have.been.calledOnceWithExactly('waf.updates', {
          waf_version: wafVersion,
          event_rules_version: rulesVersion
        })
        expect(inc).to.have.been.calledOnce
      })

      it('should increment waf.updates metric multiple times', () => {
        sinon.restore()

        appsecTelemetry.incrementWafUpdatesMetric(wafVersion, rulesVersion)
        appsecTelemetry.incrementWafUpdatesMetric(wafVersion, rulesVersion)
        appsecTelemetry.incrementWafUpdatesMetric(wafVersion, rulesVersion)

        const { metrics } = appsecNamespace.toJSON()
        expect(metrics.series.length).to.be.eq(1)
        expect(metrics.series[0].metric).to.be.eq('waf.updates')
        expect(metrics.series[0].points.length).to.be.eq(1)
        expect(metrics.series[0].points[0][1]).to.be.eq(3)
        expect(metrics.series[0].tags).to.include('waf_version:0.0.1')
        expect(metrics.series[0].tags).to.include('event_rules_version:0.0.2')
      })
    })

    describe('incWafRequestsMetric', () => {
      it('should increment waf.requests metric', () => {
        appsecTelemetry.updateWafRequestsMetricTags({
          blockTriggered: false,
          ruleTriggered: false,
          wafTimeout: true,
          wafVersion,
          rulesVersion
        }, req)

        appsecTelemetry.incrementWafRequestsMetric(req)

        expect(count).to.have.been.calledOnceWithExactly('waf.requests', {
          request_blocked: false,
          rule_triggered: false,
          waf_timeout: true,
          waf_version: wafVersion,
          event_rules_version: rulesVersion
        })
      })

      it('should not fail if req has no previous tag', () => {
        appsecTelemetry.incrementWafRequestsMetric(req)

        expect(count).to.not.have.been.called
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
  })
})
