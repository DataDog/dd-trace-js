'use strict'

require('../setup/core')
const assert = require('assert')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const { metrics } = require('@opentelemetry/api')

describe('OpenTelemetry Metrics Configuration', () => {
  let originalEnv

  function setupTracer (enabled = true) {
    process.env.DD_METRICS_OTEL_ENABLED = enabled ? 'true' : 'false'
    const tracer = require('../../')
    tracer._initialized = false
    tracer.init()
    return { tracer, metrics, meterProvider: metrics.getMeterProvider() }
  }

  beforeEach(() => {
    originalEnv = { ...process.env }
    // Clear any metrics-related env vars
    delete process.env.DD_METRICS_OTEL_ENABLED
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT
    delete process.env.OTEL_METRIC_EXPORT_INTERVAL
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS
    delete process.env.OTEL_EXPORTER_OTLP_TIMEOUT
  })

  afterEach(() => {
    process.env = originalEnv
    
    // Clean up meter provider
    const provider = metrics.getMeterProvider()
    if (provider && provider.shutdown) {
      provider.shutdown()
    }
    metrics.disable()
  })

  describe('Protocol Configuration', () => {
    it('uses default protobuf protocol', () => {
      delete process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL
      delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL
      const { meterProvider } = setupTracer()
      assert(meterProvider.reader)
      assert.strictEqual(meterProvider.reader.exporter.transformer.protocol, 'http/protobuf')
    })

    it('configures protocol from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json'
      const { meterProvider } = setupTracer()
      assert.strictEqual(meterProvider.reader.exporter.transformer.protocol, 'http/json')
    })

    it('prioritizes metrics-specific protocol over generic protocol', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = 'http/json'
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf'
      const { meterProvider } = setupTracer()
      assert.strictEqual(meterProvider.reader.exporter.transformer.protocol, 'http/json')
    })
  })

  describe('Endpoint Configuration', () => {
    it('configures OTLP endpoint from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://custom:4321/v1/metrics'
      const { meterProvider } = setupTracer()
      assert.strictEqual(meterProvider.reader.exporter.options.path, '/v1/metrics')
      assert.strictEqual(meterProvider.reader.exporter.options.hostname, 'custom')
      assert.strictEqual(meterProvider.reader.exporter.options.port, '4321')
    })

    it('prioritizes metrics-specific endpoint over generic endpoint', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://custom:4318/v1/metrics'
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://generic:4318/v1/metrics'
      const { meterProvider } = setupTracer()
      assert.strictEqual(meterProvider.reader.exporter.options.path, '/v1/metrics')
      assert.strictEqual(meterProvider.reader.exporter.options.hostname, 'custom')
      assert.strictEqual(meterProvider.reader.exporter.options.port, '4318')
    })

    it('appends /v1/metrics to endpoint if not provided', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://custom:4318'
      const { meterProvider } = setupTracer()
      assert.strictEqual(meterProvider.reader.exporter.options.path, '/v1/metrics')
    })
  })

  describe('Headers Configuration', () => {
    it('configures OTLP headers from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'api-key=secret,env=prod'
      const { meterProvider } = setupTracer()
      const exporter = meterProvider.reader.exporter
      assert.strictEqual(exporter.options.headers['api-key'], 'secret')
      assert.strictEqual(exporter.options.headers.env, 'prod')
    })

    it('prioritizes metrics-specific headers over generic OTLP headers', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'generic=value,shared=generic'
      process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS = 'metrics-specific=value,shared=metrics'
      const { meterProvider } = setupTracer()
      const exporter = meterProvider.reader.exporter
      assert.strictEqual(exporter.options.headers['metrics-specific'], 'value')
      assert.strictEqual(exporter.options.headers.shared, 'metrics')
      assert.strictEqual(exporter.options.headers.generic, undefined)
    })
  })

  describe('Timeout Configuration', () => {
    it('uses default timeout when not set', () => {
      const { meterProvider } = setupTracer()
      assert.strictEqual(meterProvider.reader.exporter.options.timeout, 10000)
    })

    it('configures OTLP timeout from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT = '1000'
      const { meterProvider } = setupTracer()
      assert.strictEqual(meterProvider.reader.exporter.options.timeout, 1000)
    })

    it('prioritizes metrics-specific timeout over generic timeout', () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT = '1000'
      process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '2000'
      const { meterProvider } = setupTracer()
      assert.strictEqual(meterProvider.reader.exporter.options.timeout, 1000)
    })

    it('falls back to generic timeout when metrics-specific not set', () => {
      process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '5000'
      const { meterProvider } = setupTracer()
      assert.strictEqual(meterProvider.reader.exporter.options.timeout, 5000)
    })
  })

  describe('Export Interval Configuration', () => {
    it('accepts custom export interval from environment variable', () => {
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '30000'
      const { meterProvider } = setupTracer()
      // Export interval is private, but we can verify the reader was initialized
      assert(meterProvider.reader)
      assert(meterProvider.reader.exporter)
    })

    it('initializes with default export interval when not set', () => {
      const { meterProvider } = setupTracer()
      // Verify the reader is properly initialized
      assert(meterProvider.reader)
      assert(meterProvider.reader.exporter)
    })
  })

  describe('Initialization', () => {
    it('does not initialize when OTEL metrics are disabled', () => {
      const { meterProvider } = setupTracer(false)
      const { MeterProvider } = require('../../src/opentelemetry/metrics')

      // Should return no-op provider when disabled, not our custom MeterProvider
      assert.strictEqual(meterProvider instanceof MeterProvider, false)
    })

    it('initializes meter provider when OTEL metrics are enabled', () => {
      const { meterProvider } = setupTracer(true)
      const { MeterProvider } = require('../../src/opentelemetry/metrics')

      // Should return our custom MeterProvider when enabled
      assert.strictEqual(meterProvider instanceof MeterProvider, true)
      assert(meterProvider.reader)
      assert(meterProvider.reader.exporter)
    })

    it('provides functional meter for recording metrics', () => {
      const { meterProvider } = setupTracer(true)
      const meter = meterProvider.getMeter('test-meter', '1.0.0')

      assert(meter)
      assert(typeof meter.createCounter === 'function')
      assert(typeof meter.createHistogram === 'function')
      assert(typeof meter.createUpDownCounter === 'function')
      assert(typeof meter.createObservableGauge === 'function')
    })
  })
})

