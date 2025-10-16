'use strict'

// Increase max listeners to avoid warnings in tests
process.setMaxListeners(50)

require('../setup/core')
const assert = require('assert')
const http = require('http')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const { metrics } = require('@opentelemetry/api')
const { initializeOpenTelemetryMetrics } = require('../../src/opentelemetry/metrics')
const { protoMetricsService } = require('../../src/opentelemetry/otlp/protobuf_loader').getProtobufTypes()

describe('OpenTelemetry Meter Provider', () => {
  let originalEnv
  let httpStub

  function mockConfig (overrides = {}) {
    return {
      service: 'test-service',
      version: '1.0.0',
      env: 'test',
      tags: {},
      reportHostname: false,
      otelMetricsUrl: 'http://localhost:4318/v1/metrics',
      otelMetricsHeaders: '',
      otelMetricsTimeout: 5000,
      otelMetricsProtocol: 'http/protobuf',
      otelMetricsExportInterval: 100,
      otelMetricsTemporalityPreference: 'DELTA',
      ...overrides
    }
  }

  function mockOtlpExport (validator) {
    let capturedPayload, capturedHeaders
    let validatorCalled = false

    if (httpStub) {
      httpStub.restore()
      httpStub = null
    }

    httpStub = sinon.stub(http, 'request').callsFake((options, callback) => {
      if (options.path && options.path.includes('/v1/metrics')) {
        capturedHeaders = options.headers
        const responseHandlers = {}
        const mockRes = {
          statusCode: 200,
          on: (event, handler) => {
            responseHandlers[event] = handler
            return mockRes
          },
          setTimeout: () => mockRes
        }

        const mockReq = {
          write: (data) => { capturedPayload = data },
          end: () => {
            const contentType = capturedHeaders['Content-Type']
            const isJson = contentType && contentType.includes('application/json')

            const decoded = isJson
              ? JSON.parse(capturedPayload.toString())
              : protoMetricsService.toObject(protoMetricsService.decode(capturedPayload), {
                longs: Number,
                defaults: false
              })

            validator(decoded, capturedHeaders)
            validatorCalled = true

            if (responseHandlers.end) {
              responseHandlers.end()
            }
          },
          on: () => {},
          once: () => {},
          setTimeout: () => {}
        }
        callback(mockRes)
        return mockReq
      }

      const mockReq = {
        write: () => {},
        end: () => {},
        on: () => {},
        once: () => {},
        setTimeout: () => {}
      }
      callback({ statusCode: 200, on: () => {}, setTimeout: () => {} })
      return mockReq
    })

    return () => {
      if (!validatorCalled) {
        throw new Error('OTLP export validator was never called')
      }
    }
  }

  // Helper to assert metric value (either asInt or asDouble, not both)
  function assertMetricValue (dataPoint, expectedValue, message) {
    // First verify only one type is set
    assert(
      (dataPoint.asInt !== undefined) !== (dataPoint.asDouble !== undefined),
      'Should have exactly one of asInt or asDouble'
    )

    // Then check the value matches
    if (dataPoint.asInt !== undefined) {
      assert.strictEqual(dataPoint.asInt, expectedValue, message || `Expected asInt to be ${expectedValue}`)
    } else {
      assert.strictEqual(dataPoint.asDouble, expectedValue, message || `Expected asDouble to be ${expectedValue}`)
    }
  }

  beforeEach(() => {
    originalEnv = { ...process.env }
  })

  afterEach(async () => {
    process.env = originalEnv

    const provider = metrics.getMeterProvider()
    if (provider && provider.shutdown) {
      await provider.shutdown()
    }
    metrics.disable()

    if (httpStub) {
      httpStub.restore()
      httpStub = null
    }
    sinon.restore()

    await new Promise(resolve => setTimeout(resolve, 10))
  })

  describe('Basic Functionality', () => {
    it('exports counter metrics', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const counter = metrics[0]
        assert.strictEqual(counter.name, 'requests')
        assert.strictEqual(counter.sum.isMonotonic, true)
        assert.strictEqual(counter.sum.dataPoints.length, 1, 'Should have exactly 1 data point')
        assertMetricValue(counter.sum.dataPoints[0], 5)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      meter.createCounter('requests').add(5)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('exports histogram metrics', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const histogram = metrics[0]
        assert.strictEqual(histogram.name, 'duration')
        assert(histogram.histogram, 'Should have histogram data')
        assert.strictEqual(histogram.histogram.dataPoints.length, 1, 'Should have exactly 1 data point')
        const dp = histogram.histogram.dataPoints[0]
        assert.strictEqual(dp.count, 1, 'Should have recorded 1 value')
        assert.strictEqual(dp.sum, 100, 'Sum should be 100')
        assert(Array.isArray(dp.bucketCounts), 'Should have bucket counts')
        assert(Array.isArray(dp.explicitBounds), 'Should have explicit bounds')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      meter.createHistogram('duration').record(100)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('histogram ignores negative values', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const histogram = metrics.find(m => m.name === 'size')
        const dp = histogram.histogram.dataPoints[0]
        assert.strictEqual(dp.count, 2)
        assert.strictEqual(dp.sum, 300)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const hist = meter.createHistogram('size')
      hist.record(100)
      hist.record(-50)
      hist.record(200)
      hist.record(-100)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('exports gauge metrics (last value wins)', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const gauge = metrics[0]
        assert.strictEqual(gauge.name, 'temperature')
        assert(gauge.gauge, 'Should have gauge data')
        assert.strictEqual(gauge.gauge.dataPoints.length, 1, 'Should have exactly 1 data point')
        assertMetricValue(gauge.gauge.dataPoints[0], 75, 'Last value should win')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const temp = meter.createGauge('temperature')
      temp.record(72)
      temp.record(75)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('exports updowncounter metrics', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const updown = metrics[0]
        assert.strictEqual(updown.name, 'queue')
        assert.strictEqual(updown.sum.isMonotonic, false)
        assert.strictEqual(updown.sum.dataPoints.length, 1, 'Should have exactly 1 data point')
        assertMetricValue(updown.sum.dataPoints[0], 7, 'Should be 10 - 3 = 7')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const queue = meter.createUpDownCounter('queue')
      queue.add(10)
      queue.add(-3)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('exports observable gauge metrics', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const gauge = metrics[0]
        assert.strictEqual(gauge.name, 'memory')
        assert(gauge.gauge, 'Should have gauge data')
        assert.strictEqual(gauge.gauge.dataPoints.length, 1, 'Should have exactly 1 data point')
        const dp = gauge.gauge.dataPoints[0]
        // Verify value is present and positive (memory is dynamic, so we just check it's positive)
        const value = dp.asDouble !== undefined ? dp.asDouble : dp.asInt
        assert(dp.asDouble !== undefined || dp.asInt !== undefined, 'Should have either asDouble or asInt')
        assert(value > 0, 'Memory should be positive')
        // Verify it has attributes
        assert(Array.isArray(dp.attributes), 'Should have attributes array')
        const typeAttr = dp.attributes.find(a => a.key === 'type')
        assert.strictEqual(typeAttr.value.stringValue, 'heap')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const mem = meter.createObservableGauge('memory')
      mem.addCallback((result) => result.observe(process.memoryUsage().heapUsed, { type: 'heap' }))

      setTimeout(() => { validator(); done() }, 150)
    })

    it('exports observable counter metrics', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const counter = metrics[0]
        assert.strictEqual(counter.name, 'connections')
        assert(counter.sum, 'Should have sum data')
        assert.strictEqual(counter.sum.isMonotonic, true)
        assert.strictEqual(counter.sum.dataPoints.length, 1, 'Should have exactly 1 data point')
        // Observable counters report the observed value
        const dataPoint = counter.sum.dataPoints[0]
        assert(dataPoint.asInt !== undefined || dataPoint.asDouble !== undefined, 'Should have a value')
        const value = dataPoint.asInt !== undefined ? dataPoint.asInt : dataPoint.asDouble
        assert(value >= 0, 'Observable counter value should be non-negative')
        assert.strictEqual(value, 42)
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsTemporalityPreference: 'CUMULATIVE' }))
      const meter = metrics.getMeter('app')
      const conn = meter.createObservableCounter('connections')
      conn.addCallback((result) => result.observe(42))

      setTimeout(() => { validator(); done() }, 150)
    })

    it('exports observable updowncounter metrics', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const updown = metrics[0]
        assert.strictEqual(updown.name, 'tasks')
        assert(updown.sum, 'Should have sum data')
        assert.strictEqual(updown.sum.isMonotonic, false)
        assert.strictEqual(updown.sum.dataPoints.length, 1, 'Should have exactly 1 data point')
        // Observable updowncounters report the observed value
        const dataPoint = updown.sum.dataPoints[0]
        assert(dataPoint.asInt !== undefined || dataPoint.asDouble !== undefined, 'Should have a value')
        const value = dataPoint.asInt !== undefined ? dataPoint.asInt : dataPoint.asDouble
        assert.strictEqual(value, 15)
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsTemporalityPreference: 'CUMULATIVE' }))
      const meter = metrics.getMeter('app')
      const tasks = meter.createObservableUpDownCounter('tasks')
      tasks.addCallback((result) => result.observe(15))

      setTimeout(() => { validator(); done() }, 150)
    })
  })

  describe('Configuration', () => {
    it('uses protobuf with numeric timestamps by default', (done) => {
      const validator = mockOtlpExport((decoded, headers) => {
        assert.strictEqual(headers['Content-Type'], 'application/x-protobuf')
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const dataPoint = metrics[0].sum.dataPoints[0]
        // Protobuf should use numbers for timestamps (fixed64) and values
        assert.strictEqual(typeof dataPoint.timeUnixNano, 'number')
        assert.strictEqual(typeof dataPoint.startTimeUnixNano, 'number')
        assert(dataPoint.timeUnixNano > 0, 'Timestamp should be positive')
        assertMetricValue(dataPoint, 5)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      meter.createCounter('test').add(5)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('uses JSON with string timestamps when configured', (done) => {
      const validator = mockOtlpExport((decoded, headers) => {
        assert.strictEqual(headers['Content-Type'], 'application/json')
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const dataPoint = metrics[0].sum.dataPoints[0]
        // JSON should use strings for 64-bit integers to avoid precision loss
        assert.strictEqual(typeof dataPoint.timeUnixNano, 'string')
        assert.strictEqual(typeof dataPoint.startTimeUnixNano, 'string')
        assert(parseInt(dataPoint.timeUnixNano) > 0, 'Timestamp should be positive')
        // Integer values also become strings, but doubles stay as numbers
        assert.strictEqual(typeof dataPoint.asInt, 'string')
        assert.strictEqual(dataPoint.asInt, '5')
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsProtocol: 'http/json' }))
      const meter = metrics.getMeter('app')
      meter.createCounter('test').add(5)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('includes custom resource attributes', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const attrs = {}
        decoded.resourceMetrics[0].resource.attributes.forEach(attr => {
          attrs[attr.key] = attr.value.stringValue || attr.value.intValue
        })
        assert.strictEqual(attrs['service.name'], 'custom')
        assert.strictEqual(attrs['service.version'], '2.0.0')
      })

      initializeOpenTelemetryMetrics(mockConfig({ service: 'custom', version: '2.0.0' }))
      const meter = metrics.getMeter('app')
      meter.createCounter('test').add(1)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('supports multiple attributes and data points', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const counter = metrics[0]
        assert.strictEqual(counter.name, 'api')
        assert.strictEqual(counter.sum.dataPoints.length, 2, 'Should have exactly 2 data points')

        // Find data points by attributes
        const getDp = (method) => counter.sum.dataPoints.find(dp =>
          dp.attributes.some(a => a.key === 'method' && a.value.stringValue === method)
        )

        const getDataPoint = getDp('GET')
        const postDataPoint = getDp('POST')

        assert(getDataPoint, 'Should have GET data point')
        assert(postDataPoint, 'Should have POST data point')

        assertMetricValue(getDataPoint, 10)
        assertMetricValue(postDataPoint, 5)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const api = meter.createCounter('api')
      api.add(10, { method: 'GET' })
      api.add(5, { method: 'POST' })

      setTimeout(() => { validator(); done() }, 150)
    })
  })

  describe('Temporality', () => {
    it('supports CUMULATIVE for counters', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const counter = metrics[0]
        assert.strictEqual(counter.name, 'test')
        assert.strictEqual(counter.sum.aggregationTemporality, 2)
        assert.strictEqual(counter.sum.dataPoints.length, 1, 'Should have exactly 1 data point')
        assertMetricValue(counter.sum.dataPoints[0], 8)
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsTemporalityPreference: 'CUMULATIVE' }))
      const meter = metrics.getMeter('app')
      const counter = meter.createCounter('test')
      counter.add(5)
      counter.add(3)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('supports DELTA for counters', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const counter = metrics[0]
        assert.strictEqual(counter.name, 'test')
        assert.strictEqual(counter.sum.aggregationTemporality, 1)
        assert.strictEqual(counter.sum.dataPoints.length, 1, 'Should have exactly 1 data point')
        assertMetricValue(counter.sum.dataPoints[0], 5)
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsTemporalityPreference: 'DELTA' }))
      const meter = metrics.getMeter('app')
      meter.createCounter('test').add(5)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('LOWMEMORY uses DELTA for sync counters', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const counter = metrics[0]
        assert.strictEqual(counter.name, 'sync')
        assert.strictEqual(counter.sum.aggregationTemporality, 1)
        assert.strictEqual(counter.sum.dataPoints.length, 1, 'Should have exactly 1 data point')
        assertMetricValue(counter.sum.dataPoints[0], 5)
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsTemporalityPreference: 'LOWMEMORY' }))
      const meter = metrics.getMeter('app')
      meter.createCounter('sync').add(5)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('LOWMEMORY uses CUMULATIVE for observable counters', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const counter = metrics[0]
        assert.strictEqual(counter.name, 'obs')
        assert.strictEqual(counter.sum.aggregationTemporality, 2)
        assert.strictEqual(counter.sum.dataPoints.length, 1, 'Should have exactly 1 data point')
        assertMetricValue(counter.sum.dataPoints[0], 10)
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsTemporalityPreference: 'LOWMEMORY' }))
      const meter = metrics.getMeter('app')
      const obs = meter.createObservableCounter('obs')
      obs.addCallback((result) => result.observe(10))

      setTimeout(() => { validator(); done() }, 150)
    })

    it('updowncounter always uses CUMULATIVE', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const updown = metrics[0]
        assert.strictEqual(updown.name, 'updown')
        assert.strictEqual(updown.sum.aggregationTemporality, 2)
        assert.strictEqual(updown.sum.dataPoints.length, 1, 'Should have exactly 1 data point')
        assertMetricValue(updown.sum.dataPoints[0], 5)
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsTemporalityPreference: 'DELTA' }))
      const meter = metrics.getMeter('app')
      meter.createUpDownCounter('updown').add(5)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('observable updowncounter always uses CUMULATIVE', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const updown = metrics[0]
        assert.strictEqual(updown.name, 'obs.updown')
        assert.strictEqual(updown.sum.aggregationTemporality, 2)
        assert.strictEqual(updown.sum.dataPoints.length, 1, 'Should have exactly 1 data point')
        assertMetricValue(updown.sum.dataPoints[0], 10)
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsTemporalityPreference: 'DELTA' }))
      const meter = metrics.getMeter('app')
      const obs = meter.createObservableUpDownCounter('obs.updown')
      obs.addCallback((result) => result.observe(10))

      setTimeout(() => { validator(); done() }, 150)
    })
  })

  describe('Case Insensitivity', () => {
    it('meter names are case-insensitive', () => {
      initializeOpenTelemetryMetrics(mockConfig())
      const meter1 = metrics.getMeter('MyApp')
      const meter2 = metrics.getMeter('myapp')
      assert.strictEqual(meter1, meter2)
    })

    it('metric names are case-insensitive', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 1, 'Should have exactly 1 metric')
        const counter = metrics[0]
        assert.strictEqual(counter.name, 'mymetric')
        assert.strictEqual(counter.sum.dataPoints.length, 1, 'Should have exactly 1 data point')
        assertMetricValue(counter.sum.dataPoints[0], 6)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const c1 = meter.createCounter('MyMetric')
      const c2 = meter.createCounter('mymetric')
      c1.add(1)
      c2.add(2)
      meter.createCounter('MYMETRIC').add(3)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('different instrument types with same name are distinct', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        assert.strictEqual(metrics.length, 2, 'Should have exactly 2 metrics')
        const counter = metrics.find(m => m.sum)
        const histogram = metrics.find(m => m.histogram)
        assert(counter, 'Should have counter')
        assert(histogram, 'Should have histogram')
        assert.strictEqual(counter.name, 'test')
        assert.strictEqual(histogram.name, 'test')
        assert.strictEqual(counter.sum.dataPoints.length, 1, 'Counter should have 1 data point')
        assert.strictEqual(histogram.histogram.dataPoints.length, 1, 'Histogram should have 1 data point')
        assertMetricValue(counter.sum.dataPoints[0], 5)
        assert.strictEqual(histogram.histogram.dataPoints[0].count, 1)
        assert.strictEqual(histogram.histogram.dataPoints[0].sum, 100)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      meter.createCounter('Test').add(5)
      meter.createHistogram('TEST').record(100)

      setTimeout(() => { validator(); done() }, 150)
    })
  })

  describe('Lifecycle', () => {
    it('returns no-op meter after shutdown', async () => {
      initializeOpenTelemetryMetrics(mockConfig())
      const provider = metrics.getMeterProvider()
      await provider.shutdown()

      const meter = metrics.getMeter('test')
      assert(typeof meter.createCounter === 'function')
      meter.createCounter('test').add(1) // Should not throw
    })

    it('handles shutdown gracefully', async () => {
      initializeOpenTelemetryMetrics(mockConfig())
      const provider = metrics.getMeterProvider()
      await provider.shutdown()
      await provider.shutdown() // Second shutdown should be safe
    })

    it('handles forceFlush', async () => {
      const validator = mockOtlpExport((decoded) => {
        assert(decoded.resourceMetrics)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      meter.createCounter('test').add(1)

      const provider = metrics.getMeterProvider()
      await provider.forceFlush()
      validator()
    })

    it('encodes instrumentation scope attributes', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const scopeMetrics = decoded.resourceMetrics[0].scopeMetrics
        assert.strictEqual(scopeMetrics.length, 1, 'Should have exactly 1 scope')
        const scope = scopeMetrics[0].scope
        assert.strictEqual(scope.name, 'my-app')
        assert(scope.attributes, 'Scope should have attributes')
        assert.strictEqual(scope.attributes.length, 2, 'Should have 2 attributes')
        const envAttr = scope.attributes.find(a => a.key === 'env')
        assert(envAttr, 'Should have env attribute')
        assert.strictEqual(envAttr.value.stringValue, 'production')
        const regionAttr = scope.attributes.find(a => a.key === 'region')
        assert(regionAttr, 'Should have region attribute')
        assert.strictEqual(regionAttr.value.stringValue, 'us-east-1')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('my-app', '1.0.0', {
        attributes: { env: 'production', region: 'us-east-1' }
      })
      meter.createCounter('requests').add(10)

      setTimeout(() => { validator(); done() }, 150)
    })
  })
})
