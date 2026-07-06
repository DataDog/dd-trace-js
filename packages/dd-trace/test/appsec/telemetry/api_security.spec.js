'use strict'

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const telemetryMetrics = require('../../../src/telemetry/metrics')
const appsecNamespace = telemetryMetrics.manager.namespace('appsec')

const appsecTelemetry = require('../../../src/appsec/telemetry')
const getConfig = require('../../../src/config')

describe('Appsec API Security Telemetry metrics', () => {
  let count, inc

  beforeEach(() => {
    inc = sinon.spy()
    count = sinon.stub(appsecNamespace, 'count').returns({
      inc,
    })

    appsecNamespace.metrics.clear()
    appsecNamespace.distributions.clear()
  })

  afterEach(sinon.restore)

  describe('if enabled', () => {
    beforeEach(() => {
      const config = getConfig()
      config.telemetry.DD_INSTRUMENTATION_TELEMETRY_ENABLED = true
      config.telemetry.DD_TELEMETRY_METRICS_ENABLED = true

      appsecTelemetry.enable(config)
    })

    afterEach(() => appsecTelemetry.disable())

    describe('incrementApiSecRequestSchemaMetric', () => {
      it('should increment api_security.request.schema metric with framework tag', () => {
        appsecTelemetry.incrementApiSecRequestSchemaMetric('express')

        sinon.assert.calledOnceWithExactly(count, 'api_security.request.schema', { framework: 'express' })
        sinon.assert.calledOnce(inc)
      })

      it('should normalize framework name (lowercase and spaces to underscores)', () => {
        appsecTelemetry.incrementApiSecRequestSchemaMetric('Next JS')

        sinon.assert.calledOnceWithExactly(count, 'api_security.request.schema', { framework: 'next_js' })
      })

      it('should use "unknown" framework tag when framework is not available', () => {
        appsecTelemetry.incrementApiSecRequestSchemaMetric(undefined)

        sinon.assert.calledOnceWithExactly(count, 'api_security.request.schema', { framework: 'unknown' })
      })
    })

    describe('incrementApiSecRequestNoSchemaMetric', () => {
      it('should increment api_security.request.no_schema metric with framework tag', () => {
        appsecTelemetry.incrementApiSecRequestNoSchemaMetric('fastify')

        sinon.assert.calledOnceWithExactly(count, 'api_security.request.no_schema', { framework: 'fastify' })
        sinon.assert.calledOnce(inc)
      })
    })

    describe('incrementApiSecMissingRouteMetric', () => {
      it('should increment api_security.missing_route metric with framework tag', () => {
        appsecTelemetry.incrementApiSecMissingRouteMetric('koa')

        sinon.assert.calledOnceWithExactly(count, 'api_security.missing_route', { framework: 'koa' })
        sinon.assert.calledOnce(inc)
      })
    })
  })

  describe('if telemetry is disabled', () => {
    beforeEach(() => {
      const config = getConfig()
      config.telemetry.DD_INSTRUMENTATION_TELEMETRY_ENABLED = false
      config.telemetry.DD_TELEMETRY_METRICS_ENABLED = false

      appsecTelemetry.enable(config)
    })

    afterEach(() => appsecTelemetry.disable())

    it('should not emit any api_security metric', () => {
      appsecTelemetry.incrementApiSecRequestSchemaMetric('express')
      appsecTelemetry.incrementApiSecRequestNoSchemaMetric('express')
      appsecTelemetry.incrementApiSecMissingRouteMetric('express')

      sinon.assert.notCalled(count)
    })
  })
})
