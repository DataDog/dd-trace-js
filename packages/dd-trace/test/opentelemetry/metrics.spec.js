'use strict'

process.setMaxListeners(50)

require('../setup/core')
const assert = require('assert')
const http = require('http')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const { metrics } = require('@opentelemetry/api')
const { protoMetricsService } = require('../../src/opentelemetry/otlp/protobuf_loader').getProtobufTypes()

describe('OpenTelemetry Meter Provider', () => {
  let originalEnv
  let httpStub

  function setupTracer (envOverrides = {}, setDefaultEnv = true) {
    if (setDefaultEnv) {
      process.env.DD_METRICS_OTEL_ENABLED = 'true'
      process.env.DD_SERVICE = 'test-service'
      process.env.DD_VERSION = '1.0.0'
      process.env.DD_ENV = 'test'
      process.env.OTEL_METRIC_EXPORT_INTERVAL = '100'
      process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT = '5000'
    }
    Object.assign(process.env, envOverrides)

    const tracer = require('../../')
    tracer._initialized = false
    tracer.init()
    return { tracer, meterProvider: metrics.getMeterProvider() }
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
        assert.strictEqual(metrics[0].sum.dataPoints[0].asDouble, 10.3)
      })

      setupTracer()
      const meter = metrics.getMeter('app')
      const counter = meter.createCounter('requests')
      counter.add(5.1)
      counter.add(5.2)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('exports histogram metrics', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const histogram = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(histogram.name, 'duration')
        assert.strictEqual(histogram.histogram.dataPoints[0].count, 1)
        assert.strictEqual(histogram.histogram.dataPoints[0].sum, 100)
      })

      setupTracer()
      const meter = metrics.getMeter('app')
      meter.createHistogram('duration').record(100)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('ignores negative values and callback errors', (done) => {
      let validated = false
      const validator = mockOtlpExport((decoded) => {
        const allMetrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const histogram = allMetrics.find(m => m.name === 'size')
        const counter = allMetrics.find(m => m.name === 'requests')
        const gauge = allMetrics.find(m => m.name === 'memory')

        // Only validate the export that has all three metrics (first export)
        if (histogram && counter && gauge && !validated) {
          assert.strictEqual(histogram.histogram.dataPoints[0].count, 2)
          assert.strictEqual(histogram.histogram.dataPoints[0].sum, 300)
          assert.strictEqual(counter.sum.dataPoints[0].asInt, 15)
          assert.strictEqual(gauge.gauge.dataPoints[0].asInt, 100)
          validated = true
        }
      })

      setupTracer()
      const meter = metrics.getMeter('app')

      const hist = meter.createHistogram('size')
      hist.record(100)
      hist.record(-50)
      hist.record(200)
      hist.record(-100)

      const counter = meter.createCounter('requests')
      counter.add(10)
      counter.add(-5)
      counter.add(5)

      const gauge = meter.createObservableGauge('memory')
      gauge.addCallback(() => { throw new Error('Callback error') })
      gauge.addCallback((result) => result.observe(100))

      setTimeout(() => {
        assert(validated, 'Should have validated an export with all metrics')
        validator()
        done()
      }, 150)
    })

    it('exports gauge metrics (last value wins)', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const gauge = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(gauge.name, 'temperature')
        assert.strictEqual(gauge.gauge.dataPoints[0].asInt, 75)
      })

      setupTracer()
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

      setupTracer()
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

      setupTracer()
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

      setupTracer({ OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'CUMULATIVE' })
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

      setupTracer({ OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'CUMULATIVE' })
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
        assert.strictEqual(dataPoint.asInt, 5)
        assert(dataPoint.timeUnixNano > 0)
      })

      setupTracer()
      const meter = metrics.getMeter('app')
      meter.createCounter('test').add(5)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('uses JSON with string timestamps when configured', (done) => {
      const validator = mockOtlpExport((decoded, headers) => {
        assert.strictEqual(headers['Content-Type'], 'application/json')
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const counter = metrics.find(m => m.name === 'counter')
        assert.strictEqual(counter.sum.dataPoints[0].asInt, 5)
        const histogram = metrics.find(m => m.name === 'histogram')
        assert.strictEqual(histogram.histogram.dataPoints[0].count, 2)
        assert.strictEqual(histogram.histogram.dataPoints[0].sum, 30)
        const gauge = metrics.find(m => m.name === 'gauge')
        assert.strictEqual(gauge.gauge.dataPoints[0].asInt, 100)
      })

      setupTracer({ OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json' })
      const meter = metrics.getMeter('app')
      meter.createCounter('counter').add(5)
      meter.createHistogram('histogram').record(10)
      meter.createHistogram('histogram').record(20)
      meter.createGauge('gauge').record(100)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('includes custom resource attributes and hostname when enabled', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const attrs = {}
        decoded.resourceMetrics[0].resource.attributes.forEach(attr => {
          attrs[attr.key] = attr.value.stringValue || attr.value.intValue
        })
        assert.strictEqual(attrs['service.name'], 'custom')
        assert.strictEqual(attrs['service.version'], '2.0.0')
        assert(attrs['host.name'], 'should include host.name')
      })

      setupTracer({ DD_SERVICE: 'custom', DD_VERSION: '2.0.0', DD_TRACE_REPORT_HOSTNAME: 'true' })
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

      setupTracer()
      const meter = metrics.getMeter('app')
      const api = meter.createCounter('api')
      api.add(10, { method: 'GET' })
      api.add(5, { method: 'POST' })

      setTimeout(() => { validator(); done() }, 150)
    })

    it('encodes different attribute types and drops objects', (done) => {
      let validated = false
      const validator = mockOtlpExport((decoded) => {
        if (validated) return
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
        const getAttr = (dp, key) => dp.attributes.find(a => a.key === key)?.value
        const counter = metrics.find(m => m.name === 'test')
        if (!counter) return

        const dp = counter.sum.dataPoints[0]
        assert.strictEqual(getAttr(dp, 'str').stringValue, 'val')
        assert.strictEqual(getAttr(dp, 'int').intValue, 42)
        assert.strictEqual(getAttr(dp, 'double').doubleValue, 3.14)
        assert.strictEqual(getAttr(dp, 'bool').boolValue, true)
        assert.deepStrictEqual(getAttr(dp, 'arr').arrayValue.values.map(v => v.intValue || v.doubleValue), [1, 2, 3])
        // Verify object attributes are dropped per OpenTelemetry spec
        assert.strictEqual(getAttr(dp, 'obj'), undefined)
        validated = true
      })

      setupTracer()
      const meter = metrics.getMeter('app')
      meter.createCounter('test').add(5, {
        str: 'val',
        int: 42,
        double: 3.14,
        bool: true,
        arr: [1, 2, 3],
        obj: { nested: 'dropped' }
      })

      setTimeout(() => {
        assert(validated, 'Should have validated attributes')
        validator()
        done()
      }, 150)
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

      setupTracer({ OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'CUMULATIVE' })
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

      setupTracer({ OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'DELTA' })
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

      setupTracer({ OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'LOWMEMORY' })
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

      setupTracer({ OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'LOWMEMORY' })
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

      setupTracer({ OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'DELTA' })
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

      setupTracer({ OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'DELTA' })
      const meter = metrics.getMeter('app')
      const obs = meter.createObservableUpDownCounter('obs.updown')
      obs.addCallback((result) => result.observe(10))

      setTimeout(() => { validator(); done() }, 150)
    })

    it('histograms support DELTA temporality', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const histogram = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(histogram.histogram.aggregationTemporality, 1)
        assert.strictEqual(histogram.histogram.dataPoints[0].count, 2)
        assert.strictEqual(histogram.histogram.dataPoints[0].sum, 30)
      })

      setupTracer({ OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'DELTA' })
      const meter = metrics.getMeter('app')
      meter.createHistogram('latency').record(10)
      meter.createHistogram('latency').record(20)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('histograms support CUMULATIVE temporality', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const histogram = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(histogram.histogram.aggregationTemporality, 2)
        assert.strictEqual(histogram.histogram.dataPoints[0].count, 3)
        assert.strictEqual(histogram.histogram.dataPoints[0].sum, 60)
      })

      setupTracer({ OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'CUMULATIVE' })
      const meter = metrics.getMeter('app')
      meter.createHistogram('latency').record(10)
      meter.createHistogram('latency').record(20)
      meter.createHistogram('latency').record(30)

      setTimeout(() => { validator(); done() }, 150)
    })
  })

  describe('Case Insensitivity', () => {
    it('meter names are case-insensitive', () => {
      setupTracer()
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

      setupTracer()
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

      setupTracer()
      const meter = metrics.getMeter('app')
      meter.createCounter('Test').add(5)
      meter.createHistogram('TEST').record(100)

      setTimeout(() => { validator(); done() }, 150)
    })
  })

  describe('Lifecycle', () => {
    it('returns no-op meter after shutdown', async () => {
      setupTracer()
      const provider = metrics.getMeterProvider()
      await provider.shutdown()

      const meter = metrics.getMeter('test')
      meter.createCounter('test').add(1)
      meter.createUpDownCounter('test').add(1)
      meter.createHistogram('test').record(1)
      meter.createGauge('test').record(1)
      meter.createObservableGauge('test').addCallback(() => {})
      meter.createObservableCounter('test').addCallback(() => {})
      meter.createObservableUpDownCounter('test').addCallback(() => {})
    })

    it('handles shutdown gracefully', async () => {
      setupTracer()
      const provider = metrics.getMeterProvider()
      await provider.shutdown()
      await provider.shutdown() // Second shutdown should be safe
    })

    it('handles forceFlush', async () => {
      const validator = mockOtlpExport((decoded) => {
        assert(decoded.resourceMetrics)
      })

      setupTracer()
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

      setupTracer()
      const meter = metrics.getMeter('my-app', '1.0.0', {
        attributes: { env: 'production', region: 'us-east-1' }
      })
      meter.createCounter('requests').add(10)

      setTimeout(() => { validator(); done() }, 150)
    })

    it('removes callbacks from observable instruments', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const gauge = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
        assert.strictEqual(gauge.gauge.dataPoints[0].asInt, 200)
      })

      setupTracer()
      const meter = metrics.getMeter('app')
      const gauge = meter.createObservableGauge('temperature')

      const cb1 = (result) => result.observe(100)
      const cb2 = (result) => result.observe(200)
      gauge.addCallback(cb1)
      gauge.addCallback(cb2)
      gauge.removeCallback(cb1)

      setTimeout(() => { validator(); done() }, 150)
    })
  })

  describe('Unimplemented Features', () => {
    it('logs warning for meter batch callbacks', () => {
      const log = require('../../src/log')
      const warnSpy = sinon.spy(log, 'warn')

      setupTracer()
      const meter = metrics.getMeter('app')
      meter.addBatchObservableCallback(() => {}, [])
      meter.removeBatchObservableCallback(() => {}, [])

      assert.strictEqual(warnSpy.callCount, 2)
      assert.strictEqual(warnSpy.firstCall.args[0], 'addBatchObservableCallback is not implemented')
      assert.strictEqual(warnSpy.secondCall.args[0], 'removeBatchObservableCallback is not implemented')

      warnSpy.restore()
    })
  })

  describe('Protocol Configuration', () => {
    it('uses default protobuf protocol', () => {
      const { meterProvider } = setupTracer({
        OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: undefined,
        OTEL_EXPORTER_OTLP_PROTOCOL: undefined
      })
      assert(meterProvider.reader)
      assert.strictEqual(meterProvider.reader.exporter.transformer.protocol, 'http/protobuf')
    })

    it('configures protocol from environment variable', () => {
      const { meterProvider } = setupTracer({ OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' })
      assert.strictEqual(meterProvider.reader.exporter.transformer.protocol, 'http/json')
    })

    it('prioritizes metrics-specific protocol over generic protocol', () => {
      const { meterProvider } = setupTracer({
        OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf'
      })
      assert.strictEqual(meterProvider.reader.exporter.transformer.protocol, 'http/json')
    })

    it('logs warning and falls back to protobuf when gRPC protocol is set', () => {
      const log = require('../../src/log')
      const warnSpy = sinon.spy(log, 'warn')
      const { meterProvider } = setupTracer({ OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'grpc' })
      assert.strictEqual(meterProvider.reader.exporter.transformer.protocol, 'http/protobuf')
      const expectedMsg = 'OTLP gRPC protocol is not supported for metrics. ' +
        'Defaulting to http/protobuf. gRPC protobuf support may be added in a future release.'
      assert(warnSpy.calledWith(expectedMsg))
      warnSpy.restore()
    })
  })

  describe('Endpoint Configuration', () => {
    it('configures OTLP endpoint from environment variable', () => {
      const { meterProvider } = setupTracer({
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://custom:4321/v1/metrics'
      })
      assert.strictEqual(meterProvider.reader.exporter.options.path, '/v1/metrics')
      assert.strictEqual(meterProvider.reader.exporter.options.hostname, 'custom')
      assert.strictEqual(meterProvider.reader.exporter.options.port, '4321')
    })

    it('prioritizes metrics-specific endpoint over generic endpoint', () => {
      const { meterProvider } = setupTracer({
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://custom:4318/v1/metrics',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://generic:4318/v1/metrics'
      })
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
      const { meterProvider } = setupTracer({ OTEL_EXPORTER_OTLP_HEADERS: 'api-key=secret,env=prod' })
      const exporter = meterProvider.reader.exporter
      assert.strictEqual(exporter.options.headers['api-key'], 'secret')
      assert.strictEqual(exporter.options.headers.env, 'prod')
    })

    it('prioritizes metrics-specific headers over generic OTLP headers', () => {
      const { meterProvider } = setupTracer({
        OTEL_EXPORTER_OTLP_HEADERS: 'generic=value,shared=generic',
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'metrics-specific=value,shared=metrics'
      })
      const exporter = meterProvider.reader.exporter
      assert.strictEqual(exporter.options.headers['metrics-specific'], 'value')
      assert.strictEqual(exporter.options.headers.shared, 'metrics')
      assert.strictEqual(exporter.options.headers.generic, undefined)
    })
  })

  describe('Timeout Configuration', () => {
    it('uses default timeout when not set', () => {
      const { meterProvider } = setupTracer({ OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: undefined })
      assert.strictEqual(meterProvider.reader.exporter.options.timeout, 10000)
    })

    it('configures OTLP timeout from environment variable', () => {
      const { meterProvider } = setupTracer({ OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: '1000' })
      assert.strictEqual(meterProvider.reader.exporter.options.timeout, 1000)
    })

    it('prioritizes metrics-specific timeout over generic timeout', () => {
      const { meterProvider } = setupTracer(
        { OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: '1000', OTEL_EXPORTER_OTLP_TIMEOUT: '2000' }
      )
      assert.strictEqual(meterProvider.reader.exporter.options.timeout, 1000)
    })

    it('falls back to generic timeout when metrics-specific not set', () => {
      const { meterProvider } = setupTracer({ OTEL_EXPORTER_OTLP_TIMEOUT: '5000' })
      assert.strictEqual(meterProvider.reader.exporter.options.timeout, 5000)
    })
  })

  describe('Initialization', () => {
    it('does not initialize when OTEL metrics are disabled', () => {
      const { meterProvider } = setupTracer({ DD_METRICS_OTEL_ENABLED: undefined })
      const { MeterProvider } = require('../../src/opentelemetry/metrics')

      // Should return no-op provider when disabled, not our custom MeterProvider
      assert.strictEqual(meterProvider instanceof MeterProvider, false)
    })

    it('handles shutdown correctly', () => {
      const log = require('../../src/log')
      const warnSpy = sinon.spy(log, 'warn')

      setupTracer()
      const provider = metrics.getMeterProvider()
      provider.shutdown()

      const meter = provider.getMeter('test')
      meter.createCounter('test').add(1)
      meter.createHistogram('test').record(100)
      meter.createUpDownCounter('test').add(5)
      meter.createGauge('test').record(1)
      const obsGauge = meter.createObservableGauge('test')
      obsGauge.addCallback(() => {})
      obsGauge.addCallback('not a function')

      provider.register()
      assert.strictEqual(warnSpy.callCount, 1)
      assert.strictEqual(warnSpy.firstCall.args[0], 'Cannot register after shutdown')

      warnSpy.restore()
    })
  })

  describe('HTTP Export Behavior', () => {
    it('handles timeout and error without network', (done) => {
      const results = { timeout: false, error: false }
      let requestCount = 0

      if (httpStub) {
        httpStub.restore()
        httpStub = null
      }

      httpStub = sinon.stub(http, 'request').callsFake((options, callback) => {
        requestCount++
        assert(options.headers['Content-Length'] > 0)

        const handlers = {}
        const mockReq = {
          write: sinon.stub(),
          end: sinon.stub(),
          on: (event, handler) => {
            handlers[event] = handler
            return mockReq
          },
          destroy: sinon.stub(),
          setTimeout: sinon.stub()
        }

        if (requestCount === 1) {
          setTimeout(() => { handlers.timeout && handlers.timeout(); results.timeout = true }, 10)
        } else {
          setTimeout(() => {
            handlers.error && handlers.error(new Error('Refused'))
            results.error = true
          }, 10)
        }

        return mockReq
      })

      setupTracer()
      const meter = metrics.getMeter('app')
      meter.createCounter('test1').add(1)

      setTimeout(() => {
        meter.createCounter('test2').add(2)
      }, 120)

      setTimeout(() => {
        assert(results.timeout)
        assert(results.error)
        done()
      }, 300)
    })
  })
})
