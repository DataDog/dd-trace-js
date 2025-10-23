'use strict'

process.setMaxListeners(50)

require('../setup/core')
const assert = require('assert')
const http = require('http')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const OtlpTransformer = require('../../src/opentelemetry/metrics/otlp_transformer')
const OtlpHttpMetricExporter = require('../../src/opentelemetry/metrics/otlp_http_metric_exporter')
const { protoMetricsService } = require('../../src/opentelemetry/otlp/protobuf_loader').getProtobufTypes()

describe('OTLP Metrics Export', () => {
  let resourceAttributes

  function mockOtlpExport (validator, protocol = 'protobuf') {
    let capturedPayload; let capturedHeaders; let validatorCalled = false

    sinon.stub(http, 'request').callsFake((options, callback) => {
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
            const decoded = protocol === 'json'
              ? JSON.parse(capturedPayload.toString())
              : protoMetricsService.decode(capturedPayload)
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

  const allMetricTypes = [
    {
      name: 'http_requests_total',
      type: 'counter',
      data: [{
        attributes: { method: 'GET', status_code: '200', endpoint: '/api/users' },
        startTimeUnixNano: '1000000000',
        timeUnixNano: '2000000000',
        value: 42
      }]
    },
    {
      name: 'active_connections',
      type: 'updowncounter',
      data: [{ attributes: { protocol: 'http' }, timeUnixNano: '3000000000', value: -10.5 }]
    },
    {
      name: 'http_request_duration_seconds',
      type: 'histogram',
      data: [{
        attributes: { method: 'POST', endpoint: '/api/orders' },
        startTimeUnixNano: '1000000000',
        timeUnixNano: '2000000000',
        count: 5,
        sum: 0.2505,
        min: 0.0105,
        max: 0.1000,
        bucketCounts: [1, 2, 1],
        explicitBounds: [0.01, 0.05]
      }]
    },
    {
      name: 'memory_usage_bytes',
      type: 'gauge',
      data: [{ attributes: { instance: 'web-01' }, timeUnixNano: '4000000000', value: 75 }]
    }
  ].map(m => (
    {
      ...m,
      instrumentationScope: {
        name: 'webapp-metrics',
        version: '1.0.0',
        schemaUrl: 'https://opentelemetry.io/schemas/v1.28.0',
        attributes: { 'scope.name': 'checkout' }
      }
    }))

  beforeEach(() => {
    resourceAttributes = {
      'service.name': 'ecommerce-api',
      'service.version': '2.1.0',
      'deployment.environment': 'production',
      'host.name': 'web-server-01'
    }
  })

  afterEach(() => { sinon.restore() })

  describe('Metric Transformation', () => {
    it('transforms all metric types with correct protobuf and JSON serialization', () => {
      const transformer = new OtlpTransformer(resourceAttributes, 'http/protobuf')
      const buffer = transformer.transformMetrics(allMetricTypes)
      const decoded = protoMetricsService.decode(buffer)

      const resource = decoded.resourceMetrics[0].resource
      assert(resource.attributes.find(a => a.key === 'service.name').value.stringValue === 'ecommerce-api')

      const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
      assert.strictEqual(metrics[0].sum.isMonotonic, true)
      assert.strictEqual(metrics[1].sum.isMonotonic, false)
      assert(metrics[2].histogram)
      assert(metrics[3].gauge)

      const jsonTransformer = new OtlpTransformer(resourceAttributes, 'http/json')
      const jsonBuffer = jsonTransformer.transformMetrics(allMetricTypes)
      const jsonDecoded = JSON.parse(jsonBuffer.toString())
      const jsonMetrics = jsonDecoded.resourceMetrics[0].scopeMetrics[0].metrics

      assert.strictEqual(jsonMetrics[0].sum.dataPoints[0].asInt, 42)
      assert.strictEqual(jsonMetrics[1].sum.dataPoints[0].asDouble, -10.5)
      assert.strictEqual(jsonMetrics[2].histogram.dataPoints[0].count, 5)
      assert.strictEqual(jsonMetrics[3].gauge.dataPoints[0].asInt, 75)
    })

    it('handles missing metric metadata and transforms complex attribute types to OTLP format', () => {
      const transformer = new OtlpTransformer(resourceAttributes, 'http/protobuf')

      const minimal = [{ name: 'ping_count', type: 'counter', data: [{ timeUnixNano: '1000000000', value: 1 }] }]
      const buffer = transformer.transformMetrics(minimal)
      const decoded = protoMetricsService.decode(buffer)
      const metric = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]
      assert.strictEqual(metric.description, '')
      assert.strictEqual(metric.unit, '')

      const complex = [{
        name: 'user_login_events',
        type: 'counter',
        data: [{
          attributes: {
            user_agent: 'Mozilla/5.0',
            session_count: 42,
            success_rate: 3.14159,
            authenticated: true,
            roles: ['admin', 'user'],
            metadata: { source: 'web-app' },
            null: null,
            undefined
          },
          timeUnixNano: '1000000000',
          value: 1
        }]
      }]
      const complexBuffer = transformer.transformMetrics(complex)
      const complexDecoded = protoMetricsService.decode(complexBuffer)
      const attrs = complexDecoded.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes
      assert(attrs.find(a => a.key === 'user_agent').value.stringValue === 'Mozilla/5.0')
      assert(attrs.find(a => a.key === 'success_rate').value.doubleValue === 3.14159)
    })

    it('handles optional startTimeUnixNano for gauges, missing histogram buckets, and null attributes in JSON mode',
      () => {
        const transformer = new OtlpTransformer(resourceAttributes, 'http/json')

        const noStart = [
          {
            name: 'cpu_usage_percent',
            type: 'gauge',
            data: [{ attributes: {}, timeUnixNano: '1000000000', value: 42 }]
          }
        ]
        const buffer = transformer.transformMetrics(noStart)
        const decoded = JSON.parse(buffer.toString())
        assert.strictEqual(
          decoded.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0].startTimeUnixNano,
          undefined
        )

        const minHist = [{
          name: 'request_size_bytes',
          type: 'histogram',
          data: [{ attributes: {}, timeUnixNano: '1000000000', count: 3, sum: 15.5 }]
        }]
        const histBuffer = transformer.transformMetrics(minHist)
        const histDecoded = JSON.parse(histBuffer.toString())
        const histDp = histDecoded.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0]
        assert.deepStrictEqual(histDp.bucketCounts, [])
        assert.deepStrictEqual(histDp.explicitBounds, [])

        const nullAttrs = [{
          name: 'system_errors_total',
          type: 'counter',
          data: [{ attributes: null, timeUnixNano: '1000000000', value: 1 }]
        }]
        const nullBuffer = transformer.transformMetrics(nullAttrs)
        const nullDecoded = JSON.parse(nullBuffer.toString())
        assert.deepStrictEqual(
          nullDecoded.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes,
          []
        )
      })

    it('warns and falls back when unsupported gRPC protocol is used', () => {
      const log = require('../../src/log')
      const warnSpy = sinon.spy(log, 'warn')

      const transformer = new OtlpTransformer(resourceAttributes, 'grpc')
      assert.strictEqual(transformer.protocol, 'http/protobuf')
      assert(warnSpy.calledOnce)
      assert(warnSpy.firstCall.args[0].includes('gRPC protocol is not supported'))

      warnSpy.restore()
    })

    it('uses separate protobuf fields for integer vs double metric values', () => {
      const transformer = new OtlpTransformer(resourceAttributes, 'http/protobuf')

      const mixedValues = [
        {
          name: 'database_connections_total',
          type: 'counter',
          data: [{ attributes: {}, timeUnixNano: '1000000000', value: 42 }]
        },
        {
          name: 'cache_hit_ratio',
          type: 'counter',
          data: [{ attributes: {}, timeUnixNano: '1000000000', value: 3.14159 }]
        }
      ]

      const buffer = transformer.transformMetrics(mixedValues)
      const decoded = protoMetricsService.decode(buffer)
      const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics

      const intValue = typeof metrics[0].sum.dataPoints[0].asInt === 'object'
        ? metrics[0].sum.dataPoints[0].asInt.toNumber()
        : metrics[0].sum.dataPoints[0].asInt
      assert.strictEqual(intValue, 42)
      assert.strictEqual(metrics[1].sum.dataPoints[0].asDouble, 3.14159)
    })
  })

  describe('HTTP Export', () => {
    it('parses URLs and headers correctly', () => {
      const exporter = new OtlpHttpMetricExporter(
        'http://example.com:4318/custom?token=abc',
        'x-api-key=secret',
        5000,
        'http/json',
        resourceAttributes
      )
      assert.strictEqual(exporter.options.hostname, 'example.com')
      assert.strictEqual(exporter.options.port, '4318')
      assert.strictEqual(exporter.options.path, '/custom?token=abc')
      assert.strictEqual(exporter.options.headers['Content-Type'], 'application/json')
      assert.strictEqual(exporter.options.headers['x-api-key'], 'secret')
    })

    it('successfully exports metrics via HTTP', (done) => {
      const validator = mockOtlpExport((decoded, headers) => {
        assert.strictEqual(headers['Content-Type'], 'application/x-protobuf')
        assert.strictEqual(decoded.resourceMetrics[0].scopeMetrics[0].metrics[0].name, 'api_calls_total')
      })

      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        '',
        5000,
        'http/protobuf',
        resourceAttributes
      )
      const metrics = [{
        name: 'api_calls_total',
        type: 'counter',
        instrumentationScope: { name: 'webapp-metrics', version: '1.0.0', schemaUrl: '' },
        data: [{ attributes: {}, timeUnixNano: '2000000000', value: 1 }]
      }]

      exporter.export(metrics, (result) => {
        assert.strictEqual(result.code, 0)
        validator()
        done()
      })
    })

    it('returns success for empty metrics arrays and handles HTTP error responses', (done) => {
      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        '',
        5000,
        'http/protobuf',
        resourceAttributes
      )

      exporter.export([], (result) => {
        assert.strictEqual(result.code, 0)

        sinon.restore()
        sinon.stub(http, 'request').callsFake((options, callback) => {
          const responseHandlers = {}
          const mockRes = {
            statusCode: 500,
            on: (event, handler) => { responseHandlers[event] = handler; return mockRes },
            setTimeout: () => mockRes
          }
          const mockReq = {
            write: () => {},
            end: () => {
              if (responseHandlers.data) responseHandlers.data('Error')
              if (responseHandlers.end) responseHandlers.end()
            },
            on: () => {},
            once: () => {},
            setTimeout: () => {}
          }
          callback(mockRes)
          return mockReq
        })

        const testMetrics = [{
          name: 'api_calls_total',
          type: 'counter',
          instrumentationScope: { name: 'webapp-metrics', version: '1.0.0', schemaUrl: '' },
          data: [{ attributes: {}, timeUnixNano: '1000000000', value: 1 }]
        }]
        exporter.export(testMetrics, (result) => {
          assert.strictEqual(result.code, 1)
          assert(result.error)
          done()
        })
      })
    })

    it('handles timeout and connection errors', (done) => {
      sinon.stub(http, 'request').callsFake((options, callback) => {
        const timeoutHandlers = {}
        const mockReq = {
          write: () => {},
          end: () => {},
          on: (event, handler) => { timeoutHandlers[event] = handler },
          once: () => {},
          setTimeout: () => {},
          destroy: () => {}
        }
        callback({ statusCode: 200, on: () => {}, setTimeout: () => {} })

        setTimeout(() => {
          if (timeoutHandlers.timeout) timeoutHandlers.timeout()
        }, 10)

        return mockReq
      })

      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        '',
        100,
        'http/protobuf',
        resourceAttributes
      )
      const metrics = [{
        name: 'api_calls_total',
        type: 'counter',
        data: [{ attributes: {}, timeUnixNano: '1000000000', value: 1 }]
      }]

      exporter.export(metrics, (result) => {
        assert.strictEqual(result.code, 1)
        assert(result.error)
        done()
      })
    })

    it('parses header strings with empty values, spaces, and malformed entries', () => {
      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        'key1=value1,key2=value with spaces,key3=',
        5000,
        'http/protobuf',
        resourceAttributes
      )
      assert.strictEqual(exporter.options.headers.key1, 'value1')
      assert.strictEqual(exporter.options.headers.key2, 'value with spaces')
      assert.strictEqual(exporter.options.headers.key3, undefined)
    })

    it('exposes telemetry and handles connection errors with logging', (done) => {
      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        '',
        5000,
        'http/protobuf',
        resourceAttributes
      )
      const tags = exporter._getTelemetryTags()
      assert(Array.isArray(tags))
      assert(tags.includes('protocol:http'))
      assert(tags.includes('encoding:protobuf'))

      sinon.restore()
      sinon.stub(http, 'request').callsFake((options, callback) => {
        const errorHandlers = {}
        const mockReq = {
          write: () => {},
          end: () => {},
          on: (event, handler) => { errorHandlers[event] = handler },
          once: () => {},
          setTimeout: () => {}
        }
        callback({ statusCode: 200, on: () => {}, setTimeout: () => {} })

        setTimeout(() => {
          if (errorHandlers.error) errorHandlers.error(new Error('Connection failed'))
        }, 10)

        return mockReq
      })

      const metrics = [
        { name: 'api_calls_total', type: 'counter', data: [{ attributes: {}, timeUnixNano: '1000000000', value: 1 }] }
      ]
      exporter.export(metrics, (result) => {
        assert.strictEqual(result.code, 1)
        assert(result.error)
        done()
      })
    })
  })
})
