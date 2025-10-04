'use strict'

// Increase max listeners to avoid warnings in tests
process.setMaxListeners(50)

const assert = require('assert')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
require('../setup/core')
const { protoMetricsService } = require('../../src/opentelemetry/protos/protobuf_loader').getProtobufTypes()

describe('OpenTelemetry Metrics', () => {
  let originalEnv

  function setupTracer (enabled = true, exportInterval = '1000') {
    process.env.DD_METRICS_OTEL_ENABLED = enabled ? 'true' : 'false'
    process.env.OTEL_METRIC_EXPORT_INTERVAL = exportInterval // Export every 1 second for tests
    const tracer = require('../../')
    tracer._initialized = false
    tracer.init()
    const { metrics } = require('@opentelemetry/api')
    return { metrics, meterProvider: metrics.getMeterProvider() }
  }

  function mockOtlpExport (validator, protocol = 'protobuf') {
    const http = require('http')
    let capturedPayload, capturedHeaders
    let validatorCalled = false

    sinon.stub(http, 'request').callsFake((options, callback) => {
      capturedHeaders = options.headers
      const mockReq = {
        write: (data) => { capturedPayload = data },
        end: () => {
          const decoded = protocol === 'json'
            ? JSON.parse(capturedPayload.toString())
            : protoMetricsService.decode(capturedPayload)
          validator(decoded, capturedHeaders)
          validatorCalled = true
        },
        on: () => {}
      }
      callback({ statusCode: 200, on: () => {}, setTimeout: () => {} })
      return mockReq
    })

    // Return function to check if validator was called
    return () => {
      if (!validatorCalled) {
        throw new Error('OTLP export validator was never called - metrics may not have been exported')
      }
    }
  }

  function mockLogWarn () {
    const log = require('../../src/log')
    const originalWarn = log.warn
    let warningMessage = ''
    log.warn = (msg) => { warningMessage = msg }
    return { restore: () => { log.warn = originalWarn }, getMessage: () => warningMessage }
  }

  beforeEach(() => {
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    process.env = originalEnv
    const { metrics } = require('@opentelemetry/api')
    metrics.disable()
    sinon.restore()
  })

  describe('Core Functionality', () => {
    it('exports metrics with complete OTLP structure', (done) => {
      mockOtlpExport((decoded, capturedHeaders) => {
        const { resource } = decoded.resourceMetrics[0]
        const resourceAttrs = {}
        resource.attributes.forEach(attr => { resourceAttrs[attr.key] = attr.value.stringValue })
        assert(resourceAttrs['service.name'])

        // Validate we have scope metrics
        const { scopeMetrics } = decoded.resourceMetrics[0]
        assert.strictEqual(scopeMetrics.length, 1)

        const scope = scopeMetrics[0]
        assert.strictEqual(scope.scope.name, 'test-meter')
        assert.strictEqual(scope.scope.version, '1.0.0')
        assert.strictEqual(scope.metrics.length, 1)

        const metric = scope.metrics[0]
        assert.strictEqual(metric.name, 'test.counter')
        assert.strictEqual(metric.description, 'A test counter')
        assert.strictEqual(metric.unit, 'requests')
        assert(metric.sum)
        assert.strictEqual(metric.sum.isMonotonic, true)
        assert.strictEqual(metric.sum.dataPoints.length, 1)
        
        const dataPoint = metric.sum.dataPoints[0]
        // For protobuf, numbers are returned as Long objects
        assert.strictEqual(typeof dataPoint.asInt === 'object' ? dataPoint.asInt.toNumber() : dataPoint.asInt, 5)
        done()
      })

      const { metrics, meterProvider } = setupTracer(true, '100')
      const meter = metrics.getMeter('test-meter', '1.0.0')
      const counter = meter.createCounter('test.counter', {
        description: 'A test counter',
        unit: 'requests'
      })

      counter.add(5, { environment: 'test' })

      // Force flush immediately
      meterProvider.forceFlush()
    })

    it('exports metrics using protobuf protocol', (done) => {
      mockOtlpExport((decoded, capturedHeaders) => {
        assert.strictEqual(
          decoded.resourceMetrics[0].scopeMetrics[0].metrics[0].name,
          'protobuf.metric'
        )
        done()
      })

      const { metrics, meterProvider } = setupTracer(true, '100')
      const meter = metrics.getMeter('test')
      const counter = meter.createCounter('protobuf.metric')
      counter.add(1)

      meterProvider.forceFlush()
    })

    it('exports metrics using JSON protocol', (done) => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'http/json'
      mockOtlpExport((decoded, capturedHeaders) => {
        assert.strictEqual(
          decoded.resourceMetrics[0].scopeMetrics[0].metrics[0].name,
          'json.metric'
        )
        done()
      }, 'json')

      const { metrics, meterProvider } = setupTracer(true, '100')
      const meter = metrics.getMeter('test')
      const counter = meter.createCounter('json.metric')
      counter.add(1)

      meterProvider.forceFlush()
    })

    it('handles shutdown gracefully', () => {
      const { meterProvider } = setupTracer(true)
      assert(meterProvider, 'meterProvider should exist')
      meterProvider.shutdown()
      assert.strictEqual(meterProvider.isShutdown, true)
    })

    it('supports multiple instrument types', (done) => {
      mockOtlpExport((decoded, capturedHeaders) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert(metrics.length >= 2)

        const counterMetric = metrics.find(m => m.name === 'test.counter')
        assert(counterMetric)
        assert(counterMetric.sum)
        assert.strictEqual(counterMetric.sum.isMonotonic, true)

        const histogramMetric = metrics.find(m => m.name === 'test.histogram')
        assert(histogramMetric)
        assert(histogramMetric.histogram)
        done()
      })

      const { metrics, meterProvider } = setupTracer(true, '100')
      const meter = metrics.getMeter('test-meter', '1.0.0')
      
      const counter = meter.createCounter('test.counter')
      counter.add(10)

      const histogram = meter.createHistogram('test.histogram')
      histogram.record(5.5)

      meterProvider.forceFlush()
    })
  })

  describe('Configurations', () => {
    it('uses default protobuf protocol', () => {
      delete process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL
      delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL
      const { meterProvider } = setupTracer(true)
      assert(meterProvider, 'meterProvider should exist')
      assert(meterProvider.reader)
      assert.strictEqual(meterProvider.reader.exporter.transformer.protocol, 'http/protobuf')
    })

    it('configures protocol from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json'
      const { meterProvider } = setupTracer(true)
      assert.strictEqual(meterProvider.reader.exporter.transformer.protocol, 'http/json')
    })

    it('prioritizes metrics-specific protocol over generic protocol', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'http/json'
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf'
      const { meterProvider } = setupTracer(true)
      assert.strictEqual(meterProvider.reader.exporter.transformer.protocol, 'http/json')
    })

    it('warns and falls back to protobuf when gRPC protocol is set', () => {
      const logMock = mockLogWarn()
      process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'grpc'

      const { meterProvider } = setupTracer(true)
      assert.strictEqual(meterProvider.reader.exporter.transformer.protocol, 'http/protobuf')
      assert(logMock.getMessage().includes('OTLP gRPC protocol is not supported'))

      logMock.restore()
    })

    it('configures OTLP endpoint from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://custom:4321/v2/metrics'
      const { meterProvider } = setupTracer(true)
      assert.strictEqual(meterProvider.reader.exporter.url, 'http://custom:4321/v2/metrics')
    })

    it('prioritizes metrics-specific endpoint over generic endpoint', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://custom:4318/v1/metrics'
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://generic:4318/v1/metrics'
      const { meterProvider } = setupTracer(true)
      assert.strictEqual(meterProvider.reader.exporter.url, 'http://custom:4318/v1/metrics')
    })

    it('configures OTLP headers from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'api-key=secret,env=prod'
      const { meterProvider } = setupTracer(true)
      const exporter = meterProvider.reader.exporter
      assert.strictEqual(exporter.headers['api-key'], 'secret')
      assert.strictEqual(exporter.headers.env, 'prod')
    })

    it('prioritizes metrics-specific headers over generic OTLP headers', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'generic=value,shared=generic'
      process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS = 'metrics-specific=value,shared=metrics'
      const { meterProvider } = setupTracer(true)
      const exporter = meterProvider.reader.exporter
      assert.strictEqual(exporter.headers['metrics-specific'], 'value')
      assert.strictEqual(exporter.headers.shared, 'metrics')
      assert.strictEqual(exporter.headers.generic, undefined)
    })

    it('configures OTLP timeout from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT = '5000'
      const { meterProvider } = setupTracer(true)
      assert.strictEqual(meterProvider.reader.exporter.timeout, 5000)
    })

    it('prioritizes metrics-specific timeout over generic timeout', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT = '3000'
      process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '5000'
      const { meterProvider } = setupTracer(true)
      assert.strictEqual(meterProvider.reader.exporter.timeout, 3000)
    })
  })
})
