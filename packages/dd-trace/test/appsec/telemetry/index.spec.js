'use strict'

const { assert } = require('chai')
const Config = require('../../../src/config')
const appsecTelemetry = require('../../../src/appsec/telemetry')
const telemetryMetrics = require('../../../src/telemetry/metrics')

describe('appsec enabled metric', () => {
  let appsecNamespace
  let originalTelemetryEnabledEnvVar, originalSetInterval, originalAppsecEnabled

  beforeEach(() => {
    originalTelemetryEnabledEnvVar = process.env.DD_TRACE_TELEMETRY_ENABLED
    originalAppsecEnabled = process.env.DD_APPSEC_ENABLED
    originalSetInterval = global.setInterval
    appsecNamespace = telemetryMetrics.manager.namespace('appsec')

    appsecNamespace.reset()
    appsecNamespace.metrics.clear()
    appsecNamespace.distributions.clear()
  })

  afterEach(() => {
    process.env.DD_TRACE_TELEMETRY_ENABLED = originalTelemetryEnabledEnvVar
    process.env.DD_APPSEC_ENABLED = originalAppsecEnabled
    global.setInterval = originalSetInterval
    appsecTelemetry.disable()
    appsecNamespace.reset()
  })

  describe('when telemetry is disabled', () => {
    beforeEach(() => {
      process.env.DD_TRACE_TELEMETRY_ENABLED = 'false'
    })

    it('should not gauge nor interval', () => {
      const config = new Config()
      global.setInterval = sinon.stub()

      appsecTelemetry.enable(config)

      sinon.assert.notCalled(global.setInterval)
    })
  })

  describe('when telemetry is enabled', () => {
    beforeEach(() => {
      process.env.DD_TRACE_TELEMETRY_ENABLED = 'true'
    })

    it('should call to gauge.track metric when is enabled by remote config', () => {
      const config = new Config()
      config.telemetry.heartbeatInterval = 10_000 // in milliseconds

      appsecTelemetry.enable(config)

      const metrics = appsecNamespace.metrics.toJSON()

      assert.equal(metrics.series.length, 1)
      assert.equal(metrics.series[0].metric, 'enabled')
      assert.equal(metrics.series[0].interval, 10)
      assert.equal(metrics.series[0].type, 'gauge')
      assert.equal(metrics.series[0].points.length, 1)
      assert.deepEqual(metrics.series[0].tags, ['origin:remote_config'])
    })

    it('should call to gauge.track metric when is enabled by environment variable', () => {
      process.env.DD_APPSEC_ENABLED = 'true'
      const config = new Config()
      config.telemetry.heartbeatInterval = 10_000 // in milliseconds

      appsecTelemetry.enable(config)

      const metrics = appsecNamespace.metrics.toJSON()

      assert.equal(metrics.series.length, 1)
      assert.equal(metrics.series[0].metric, 'enabled')
      assert.equal(metrics.series[0].interval, 10)
      assert.equal(metrics.series[0].type, 'gauge')
      assert.equal(metrics.series[0].points.length, 1)
      assert.deepEqual(metrics.series[0].tags, ['origin:env_var'])
    })

    it('should call to gauge.track metric when is enabled by code', () => {
      const config = new Config({ appsec: true })
      config.telemetry.heartbeatInterval = 10_000 // in milliseconds

      appsecTelemetry.enable(config)

      const metrics = appsecNamespace.metrics.toJSON()

      assert.equal(metrics.series.length, 1)
      assert.equal(metrics.series[0].metric, 'enabled')
      assert.equal(metrics.series[0].interval, 10)
      assert.equal(metrics.series[0].type, 'gauge')
      assert.equal(metrics.series[0].points.length, 1)
      assert.deepEqual(metrics.series[0].tags, ['origin:code'])
    })

    it('should call to track each heartbeatInterval', () => {
      const unref = sinon.stub()
      global.setInterval = sinon.stub()
      global.setInterval.returns({ unref })

      const config = new Config()
      config.telemetry.heartbeatInterval = 10_000 // in milliseconds

      appsecTelemetry.enable(config)

      sinon.assert.calledOnce(global.setInterval)
      const intervalCb = global.setInterval.firstCall.args[0]
      sinon.assert.calledOnce(unref)
      intervalCb()
      intervalCb()

      const metrics = appsecNamespace.metrics.toJSON()

      assert.equal(metrics.series.length, 1)
      assert.equal(metrics.series[0].metric, 'enabled')
      assert.equal(metrics.series[0].interval, 10)
      assert.equal(metrics.series[0].type, 'gauge')
      assert.equal(metrics.series[0].points.length, 3)
      assert.deepEqual(metrics.series[0].tags, ['origin:remote_config'])
    })
  })
})
