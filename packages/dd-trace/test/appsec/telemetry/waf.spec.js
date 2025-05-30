'use strict'

const telemetryMetrics = require('../../../src/telemetry/metrics')
const appsecNamespace = telemetryMetrics.manager.namespace('appsec')

const appsecTelemetry = require('../../../src/appsec/telemetry')
const Config = require('../../../src/config')

describe('Appsec Waf Telemetry metrics', () => {
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
    const metrics = {
      wafVersion,
      rulesVersion
    }

    beforeEach(() => {
      const config = new Config()
      config.telemetry.enabled = true
      config.telemetry.metrics = true

      appsecTelemetry.enable(config)
    })

    describe('updateWafRequestsMetricTags', () => {
      it('should skip update if no request is provided', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags(metrics)

        expect(result).to.be.undefined
      })

      it('should create a default tag', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags(metrics, req)

        expect(result).to.be.deep.eq({
          block_failure: false,
          event_rules_version: rulesVersion,
          input_truncated: false,
          rate_limited: false,
          request_blocked: false,
          rule_triggered: false,
          waf_error: false,
          waf_timeout: false,
          waf_version: wafVersion
        })
      })

      it('should create a tag with custom values', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags({
          blockTriggered: true,
          ruleTriggered: true,
          wafTimeout: true,
          rateLimited: true,
          errorCode: -1,
          maxTruncatedString: 5000,
          ...metrics
        }, req)

        expect(result).to.be.deep.eq({
          block_failure: false,
          event_rules_version: rulesVersion,
          input_truncated: true,
          rate_limited: true,
          request_blocked: true,
          rule_triggered: true,
          waf_error: true,
          waf_timeout: true,
          waf_version: wafVersion
        })
      })

      it('should update existing tag ', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags(metrics, req)

        const result2 = appsecTelemetry.updateWafRequestsMetricTags({
          ruleTriggered: true,
          rateLimited: true,
          ...metrics
        }, req)

        expect(result).to.be.eq(result2)

        expect(result).to.be.deep.eq({
          block_failure: false,
          event_rules_version: rulesVersion,
          input_truncated: false,
          rate_limited: true,
          request_blocked: false,
          rule_triggered: true,
          waf_error: false,
          waf_timeout: false,
          waf_version: wafVersion
        })
      })

      it('should handle different requests tags ', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags({
          blockTriggered: true,
          ruleTriggered: true,
          wafTimeout: true,
          rateLimited: true,
          maxTruncatedContainerSize: 300,
          ...metrics
        }, req)

        const req2 = {}
        const result2 = appsecTelemetry.updateWafRequestsMetricTags({
          blockTriggered: false,
          ruleTriggered: false,
          wafTimeout: false,
          rateLimited: false,
          ...metrics
        }, req2)

        expect(result).to.be.not.eq(result2)

        expect(result).to.be.deep.eq({
          block_failure: false,
          event_rules_version: rulesVersion,
          input_truncated: true,
          rate_limited: true,
          request_blocked: true,
          rule_triggered: true,
          waf_error: false,
          waf_timeout: true,
          waf_version: wafVersion
        })
      })

      it('should sum waf.duration metrics', () => {
        appsecTelemetry.updateWafRequestsMetricTags({
          duration: 42,
          durationExt: 52
        }, req)

        appsecTelemetry.updateWafRequestsMetricTags({
          duration: 24,
          durationExt: 25
        }, req)

        const { duration, durationExt } = appsecTelemetry.getRequestMetrics(req)

        expect(duration).to.be.eq(66)
        expect(durationExt).to.be.eq(77)
      })

      it('should increment wafTimeouts if wafTimeout is true', () => {
        appsecTelemetry.updateWafRequestsMetricTags({ wafTimeout: true }, req)
        appsecTelemetry.updateWafRequestsMetricTags({ wafTimeout: true }, req)

        const { wafTimeouts } = appsecTelemetry.getRequestMetrics(req)
        expect(wafTimeouts).to.equal(2)
      })

      it('should keep the maximum wafErrorCode', () => {
        appsecTelemetry.updateWafRequestsMetricTags({ wafVersion, rulesVersion, errorCode: -1 }, req)
        expect(count).to.have.been.calledWithExactly('waf.error', {
          waf_version: wafVersion,
          event_rules_version: rulesVersion,
          waf_error: -1
        })

        appsecTelemetry.updateWafRequestsMetricTags({ wafVersion, rulesVersion, errorCode: -3 }, req)
        expect(count).to.have.been.calledWithExactly('waf.error', {
          waf_version: wafVersion,
          event_rules_version: rulesVersion,
          waf_error: -3
        })

        const { wafErrorCode } = appsecTelemetry.getRequestMetrics(req)
        expect(wafErrorCode).to.equal(-1)
      })
    })

    describe('incWafInitMetric', () => {
      it('should increment waf.init metric', () => {
        appsecTelemetry.incrementWafInitMetric(wafVersion, rulesVersion, true)

        expect(count).to.have.been.calledOnceWithExactly('waf.init', {
          waf_version: wafVersion,
          event_rules_version: rulesVersion,
          success: true
        })
        expect(inc).to.have.been.calledOnce
      })

      it('should increment waf.init metric multiple times', () => {
        sinon.restore()

        appsecTelemetry.incrementWafInitMetric(wafVersion, rulesVersion, true)
        appsecTelemetry.incrementWafInitMetric(wafVersion, rulesVersion, true)
        appsecTelemetry.incrementWafInitMetric(wafVersion, rulesVersion, true)

        const { metrics } = appsecNamespace.toJSON()
        expect(metrics.series.length).to.be.eq(2)
        expect(metrics.series[1].metric).to.be.eq('waf.init')
        expect(metrics.series[1].points.length).to.be.eq(1)
        expect(metrics.series[1].points[0][1]).to.be.eq(3)
        expect(metrics.series[1].tags).to.include('waf_version:0.0.1')
        expect(metrics.series[1].tags).to.include('event_rules_version:0.0.2')
        expect(metrics.series[1].tags).to.include('success:true')
      })

      it('should increment waf.init and waf.config_errors on failed init', () => {
        sinon.restore()

        appsecTelemetry.incrementWafInitMetric(wafVersion, rulesVersion, false)

        const { metrics } = appsecNamespace.toJSON()
        expect(metrics.series.length).to.be.eq(3)
        expect(metrics.series[1].metric).to.be.eq('waf.init')
        expect(metrics.series[1].tags).to.include('waf_version:0.0.1')
        expect(metrics.series[1].tags).to.include('event_rules_version:0.0.2')
        expect(metrics.series[1].tags).to.include('success:false')

        expect(metrics.series[2].metric).to.be.eq('waf.config_errors')
        expect(metrics.series[2].tags).to.include('waf_version:0.0.1')
        expect(metrics.series[2].tags).to.include('event_rules_version:0.0.2')
      })
    })

    describe('incWafUpdatesMetric', () => {
      it('should increment waf.updates metric', () => {
        appsecTelemetry.incrementWafUpdatesMetric(wafVersion, rulesVersion, true)

        expect(count).to.have.been.calledOnceWithExactly('waf.updates', {
          waf_version: wafVersion,
          event_rules_version: rulesVersion,
          success: true
        })
        expect(inc).to.have.been.calledOnce
      })

      it('should increment waf.updates metric multiple times', () => {
        sinon.restore()

        appsecTelemetry.incrementWafUpdatesMetric(wafVersion, rulesVersion, true)
        appsecTelemetry.incrementWafUpdatesMetric(wafVersion, rulesVersion, true)
        appsecTelemetry.incrementWafUpdatesMetric(wafVersion, rulesVersion, true)

        const { metrics } = appsecNamespace.toJSON()
        expect(metrics.series.length).to.be.eq(2)
        expect(metrics.series[1].metric).to.be.eq('waf.updates')
        expect(metrics.series[1].points.length).to.be.eq(1)
        expect(metrics.series[1].points[0][1]).to.be.eq(3)
        expect(metrics.series[1].tags).to.include('waf_version:0.0.1')
        expect(metrics.series[1].tags).to.include('event_rules_version:0.0.2')
        expect(metrics.series[1].tags).to.include('success:true')
      })
    })

    describe('incrementWafConfigErrors', () => {
      it('should increment waf.config_errors metric', () => {
        appsecTelemetry.incrementWafConfigErrorsMetric(wafVersion, rulesVersion)

        expect(count).to.have.been.calledOnceWithExactly('waf.config_errors', {
          waf_version: wafVersion,
          event_rules_version: rulesVersion
        })
        expect(inc).to.have.been.calledOnce
      })

      it('should increment waf.config_errors metric multiple times', () => {
        sinon.restore()

        appsecTelemetry.incrementWafConfigErrorsMetric(wafVersion, rulesVersion, true)
        appsecTelemetry.incrementWafConfigErrorsMetric(wafVersion, rulesVersion, true)
        appsecTelemetry.incrementWafConfigErrorsMetric(wafVersion, rulesVersion, true)

        const { metrics } = appsecNamespace.toJSON()
        expect(metrics.series.length).to.be.eq(1)
        expect(metrics.series[0].metric).to.be.eq('waf.config_errors')
        expect(metrics.series[0].points.length).to.be.eq(1)
        expect(metrics.series[0].points[0][1]).to.be.eq(3)
        expect(metrics.series[0].tags).to.include('waf_version:0.0.1')
        expect(metrics.series[0].tags).to.include('event_rules_version:0.0.2')
      })
    })

    describe('incWafRequestsMetric', () => {
      it('should increment waf.requests metric', () => {
        appsecTelemetry.updateWafRequestsMetricTags({
          blockTriggered: true,
          blockFailed: true,
          ruleTriggered: true,
          wafTimeout: true,
          errorCode: -3,
          rateLimited: true,
          maxTruncatedString: 5000,
          wafVersion,
          rulesVersion
        }, req)

        appsecTelemetry.incrementWafRequestsMetric(req)

        expect(count).to.have.been.calledWithExactly('waf.input_truncated', { truncation_reason: 1 })
        expect(count).to.have.been.calledWithExactly('waf.requests', {
          request_blocked: true,
          block_failure: true,
          rule_triggered: true,
          waf_timeout: true,
          waf_error: true,
          rate_limited: true,
          input_truncated: true,
          waf_version: wafVersion,
          event_rules_version: rulesVersion
        })
      })

      it('should not fail if req has no previous tag', () => {
        appsecTelemetry.incrementWafRequestsMetric(req)

        expect(count).to.not.have.been.called
      })
    })

    describe('updateRateLimitedMetric', () => {
      it('should set rate_limited to true on the request tags', () => {
        appsecTelemetry.updateRateLimitedMetric(req, metrics)
        const result = appsecTelemetry.updateWafRequestsMetricTags({ wafVersion, rulesVersion }, req)
        expect(result.rate_limited).to.be.true
      })
    })

    describe('updateBlockFailureMetric', () => {
      it('should set block_failure to true on the request tags', () => {
        appsecTelemetry.updateBlockFailureMetric(req)
        const result = appsecTelemetry.updateWafRequestsMetricTags({ wafVersion, rulesVersion }, req)
        expect(result.block_failure).to.be.true
      })
    })

    describe('WAF Truncation metrics', () => {
      it('should report truncated string metrics', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags({ maxTruncatedString: 5000 }, req)
        expect(result).to.have.property('input_truncated', true)

        expect(count).to.have.been.calledWith('waf.input_truncated', { truncation_reason: 1 })
        expect(inc).to.have.been.calledWith(1)
      })

      it('should report truncated container size metrics', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags({ maxTruncatedContainerSize: 300 }, req)
        expect(result).to.have.property('input_truncated', true)

        expect(count).to.have.been.calledWith('waf.input_truncated', { truncation_reason: 2 })
        expect(inc).to.have.been.calledWith(1)
      })

      it('should report truncated container depth metrics', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags({ maxTruncatedContainerDepth: 20 }, req)
        expect(result).to.have.property('input_truncated', true)

        expect(count).to.have.been.calledWith('waf.input_truncated', { truncation_reason: 4 })
        expect(inc).to.have.been.calledWith(1)
      })

      it('should combine truncation reasons when multiple truncations occur', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags({
          maxTruncatedString: 5000,
          maxTruncatedContainerSize: 300,
          maxTruncatedContainerDepth: 20
        }, req)
        expect(result).to.have.property('input_truncated', true)

        expect(count).to.have.been.calledWith('waf.input_truncated', { truncation_reason: 7 })
      })

      it('should not report truncation metrics when no truncation occurs', () => {
        const result = appsecTelemetry.updateWafRequestsMetricTags(metrics, req)
        expect(result).to.have.property('input_truncated', false)

        expect(count).to.not.have.been.calledWith('waf.input_truncated')
        expect(distribution).to.not.have.been.calledWith('waf.truncated_value_size')
      })
    })
  })

  describe('if disabled', () => {
    it('should not increment any metric if telemetry is disabled', () => {
      appsecTelemetry.enable({
        enabled: false,
        metrics: true
      })

      appsecTelemetry.incrementWafInitMetric(wafVersion, rulesVersion, true)

      expect(count).to.not.have.been.called
      expect(inc).to.not.have.been.called
    })

    it('should not increment any metric if telemetry metrics are disabled', () => {
      appsecTelemetry.enable({
        enabled: true,
        metrics: false
      })

      appsecTelemetry.incrementWafInitMetric(wafVersion, rulesVersion, true)

      expect(count).to.not.have.been.called
      expect(inc).to.not.have.been.called
    })

    it('should not set rate_limited if telemetry is disabled', () => {
      appsecTelemetry.updateRateLimitedMetric(req, { wafVersion, rulesVersion })
      const result = appsecTelemetry.updateWafRequestsMetricTags({ wafVersion, rulesVersion }, req)
      expect(result).to.be.undefined
    })

    it('should not set block_failure if telemetry is disabled', () => {
      appsecTelemetry.updateBlockFailureMetric(req)
      const result = appsecTelemetry.updateWafRequestsMetricTags({ wafVersion, rulesVersion }, req)
      expect(result).to.be.undefined
    })

    describe('updateWafRequestMetricTags', () => {
      it('should sum waf.duration and waf.durationExt request metrics', () => {
        appsecTelemetry.enable({
          enabled: false,
          metrics: true
        })

        appsecTelemetry.updateWafRequestsMetricTags({
          duration: 42,
          durationExt: 52
        }, req)

        appsecTelemetry.updateWafRequestsMetricTags({
          duration: 24,
          durationExt: 25
        }, req)

        const { duration, durationExt } = appsecTelemetry.getRequestMetrics(req)

        expect(duration).to.be.eq(66)
        expect(durationExt).to.be.eq(77)
      })

      it('should sum waf.duration and waf.durationExt with telemetry enabled and metrics disabled', () => {
        appsecTelemetry.enable({
          enabled: true,
          metrics: false
        })

        appsecTelemetry.updateWafRequestsMetricTags({
          duration: 42,
          durationExt: 52
        }, req)

        appsecTelemetry.updateWafRequestsMetricTags({
          duration: 24,
          durationExt: 25
        }, req)

        const { duration, durationExt } = appsecTelemetry.getRequestMetrics(req)

        expect(duration).to.be.eq(66)
        expect(durationExt).to.be.eq(77)
      })
    })
  })
})
