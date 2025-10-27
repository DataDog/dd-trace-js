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
      const baseMockReq = { write: () => {}, end: () => {}, on: () => {}, once: () => {}, setTimeout: () => {} }
      const baseMockRes = { statusCode: 200, on: () => {}, setTimeout: () => {} }

      if (options.path && options.path.includes('/v1/metrics')) {
        capturedHeaders = options.headers
        const responseHandlers = {}
        const mockRes = {
          ...baseMockRes,
          on: (event, handler) => { responseHandlers[event] = handler; return mockRes }
        }

        const mockReq = {
          ...baseMockReq,
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
            if (responseHandlers.end) responseHandlers.end()
          }
        }
        callback(mockRes)
        return mockReq
      }
      callback(baseMockRes)
      return baseMockReq
    })

    return () => {
      if (!validatorCalled) throw new Error('OTLP export validator was never called')
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
        assert.strictEqual(metrics.length, 1)
        assert.strictEqual(metrics[0].name, 'requests')
        assert.strictEqual(metrics[0].sum.isMonotonic, true)
        assert.strictEqual(metrics[0].sum.dataPoints[0].asInt, 5)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      meter.createCounter('requests').add(5)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('exports histogram metrics', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const histogram = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(histogram.name, 'duration')
        assert.strictEqual(histogram.histogram.dataPoints[0].count, 1)
        assert.strictEqual(histogram.histogram.dataPoints[0].sum, 100)
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
        const gauge = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(gauge.name, 'temperature')
        assert.strictEqual(gauge.gauge.dataPoints[0].asInt, 75)
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
        const updown = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(updown.name, 'queue')
        assert.strictEqual(updown.sum.isMonotonic, false)
        assert.strictEqual(updown.sum.dataPoints[0].asInt, 7)
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
        const gauge = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(gauge.name, 'memory')
        const dp = gauge.gauge.dataPoints[0]
        const value = dp.asDouble !== undefined ? dp.asDouble : dp.asInt
        assert(value > 0)
        assert.strictEqual(dp.attributes.find(a => a.key === 'type').value.stringValue, 'heap')
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      const mem = meter.createObservableGauge('memory')
      mem.addCallback((result) => result.observe(process.memoryUsage().heapUsed, { type: 'heap' }))

      setTimeout(() => { validator(); done() }, 150)
    })

    it('exports observable counter metrics', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const counter = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(counter.name, 'connections')
        assert.strictEqual(counter.sum.isMonotonic, true)
        assert.strictEqual(counter.sum.dataPoints[0].asInt, 42)
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsTemporalityPreference: 'CUMULATIVE' }))
      const meter = metrics.getMeter('app')
      const conn = meter.createObservableCounter('connections')
      conn.addCallback((result) => result.observe(42))

      setTimeout(() => { validator(); done() }, 150)
    })

    it('exports observable updowncounter metrics', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const updown = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(updown.name, 'tasks')
        assert.strictEqual(updown.sum.isMonotonic, false)
        assert.strictEqual(updown.sum.dataPoints[0].asInt, 15)
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
        const dataPoint = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]
        assert.strictEqual(typeof dataPoint.timeUnixNano, 'number')
        assert.strictEqual(dataPoint.asInt, 5)
      })

      initializeOpenTelemetryMetrics(mockConfig())
      const meter = metrics.getMeter('app')
      meter.createCounter('test').add(5)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('uses JSON with string timestamps when configured', (done) => {
      const validator = mockOtlpExport((decoded, headers) => {
        assert.strictEqual(headers['Content-Type'], 'application/json')
        const dataPoint = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]
        assert.strictEqual(typeof dataPoint.timeUnixNano, 'string')
        assert.strictEqual(dataPoint.asInt, 5)
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
        const counter = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(counter.name, 'api')
        assert.strictEqual(counter.sum.dataPoints.length, 2)
        const getDp = (method) => counter.sum.dataPoints.find(dp =>
          dp.attributes.some(a => a.key === 'method' && a.value.stringValue === method)
        )
        assert.strictEqual(getDp('GET').asInt, 10)
        assert.strictEqual(getDp('POST').asInt, 5)
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
        const counter = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(counter.name, 'test')
        assert.strictEqual(counter.sum.aggregationTemporality, 2)
        assert.strictEqual(counter.sum.dataPoints[0].asInt, 8)
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
        const counter = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(counter.name, 'test')
        assert.strictEqual(counter.sum.aggregationTemporality, 1)
        assert.strictEqual(counter.sum.dataPoints[0].asInt, 5)
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsTemporalityPreference: 'DELTA' }))
      const meter = metrics.getMeter('app')
      meter.createCounter('test').add(5)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('LOWMEMORY uses DELTA for sync counters', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const counter = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(counter.sum.aggregationTemporality, 1)
        assert.strictEqual(counter.sum.dataPoints[0].asInt, 5)
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsTemporalityPreference: 'LOWMEMORY' }))
      const meter = metrics.getMeter('app')
      meter.createCounter('sync').add(5)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('LOWMEMORY uses CUMULATIVE for observable counters', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const counter = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(counter.sum.aggregationTemporality, 2)
        assert.strictEqual(counter.sum.dataPoints[0].asInt, 10)
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsTemporalityPreference: 'LOWMEMORY' }))
      const meter = metrics.getMeter('app')
      const obs = meter.createObservableCounter('obs')
      obs.addCallback((result) => result.observe(10))

      setTimeout(() => { validator(); done() }, 150)
    })

    it('updowncounter always uses CUMULATIVE', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const updown = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(updown.sum.aggregationTemporality, 2)
        assert.strictEqual(updown.sum.dataPoints[0].asInt, 5)
      })

      initializeOpenTelemetryMetrics(mockConfig({ otelMetricsTemporalityPreference: 'DELTA' }))
      const meter = metrics.getMeter('app')
      meter.createUpDownCounter('updown').add(5)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('observable updowncounter always uses CUMULATIVE', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const updown = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(updown.name, 'obs.updown')
        assert.strictEqual(updown.sum.aggregationTemporality, 2)
        assert.strictEqual(updown.sum.dataPoints[0].asInt, 10)
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
        const counter = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(counter.name, 'mymetric')
        assert.strictEqual(counter.sum.dataPoints[0].asInt, 6)
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
        assert.strictEqual(metrics.length, 2)
        const counter = metrics.find(m => m.sum)
        const histogram = metrics.find(m => m.histogram)
        assert(counter, 'Should have counter')
        assert(histogram, 'Should have histogram')
        assert.strictEqual(counter.name, 'test')
        assert.strictEqual(histogram.name, 'test')
        assert.strictEqual(counter.sum.dataPoints.length, 1, 'Counter should have 1 data point')
        assert.strictEqual(histogram.histogram.dataPoints.length, 1, 'Histogram should have 1 data point')
        assert.strictEqual(counter.sum.dataPoints[0].asInt, 5)
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
        const scope = decoded.resourceMetrics[0].scopeMetrics[0].scope
        assert.strictEqual(scope.name, 'my-app')
        assert.strictEqual(scope.attributes.find(a => a.key === 'env').value.stringValue, 'production')
        assert.strictEqual(scope.attributes.find(a => a.key === 'region').value.stringValue, 'us-east-1')
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
