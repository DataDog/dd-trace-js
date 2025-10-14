'use strict'

// Increase max listeners to avoid warnings in tests
process.setMaxListeners(50)

require('../setup/core')
const assert = require('assert')
const http = require('http')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const OtlpTransformer = require('../../src/opentelemetry/metrics/otlp_transformer')
const OtlpHttpMetricExporter = require('../../src/opentelemetry/metrics/otlp_http_metric_exporter')
const { protoMetricsService } = require('../../src/opentelemetry/otlp/protobuf_loader').getProtobufTypes()

describe('OpenTelemetry Metrics - OTLP Transform and Export', () => {
  let transformer
  let resourceAttributes

  function mockOtlpExport (validator, protocol = 'protobuf') {
    let capturedPayload, capturedHeaders
    let validatorCalled = false

    sinon.stub(http, 'request').callsFake((options, callback) => {
      // Only intercept OTLP metrics requests
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
            const decoded = protocol === 'json'
              ? JSON.parse(capturedPayload.toString())
              : protoMetricsService.decode(capturedPayload)
            validator(decoded, capturedHeaders)
            validatorCalled = true

            // Trigger the response end event
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

      // For other requests (remote config, etc), return a basic mock
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

    // Return function to check if validator was called
    return () => {
      if (!validatorCalled) {
        throw new Error('OTLP export validator was never called - metrics may not have been exported')
      }
    }
  }

  beforeEach(() => {
    resourceAttributes = {
      'service.name': 'test-service',
      'service.version': '1.0.0',
      'telemetry.sdk.name': 'dd-trace-js',
      'telemetry.sdk.language': 'nodejs'
    }
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('OtlpTransformer - Protobuf', () => {
    beforeEach(() => {
      transformer = new OtlpTransformer(resourceAttributes, 'http/protobuf')
    })

    it('transforms all metric types with edge cases', () => {
      const metrics = [
        // Counter with integer value
        {
          name: 'test.counter',
          description: 'A test counter',
          unit: 'operations',
          type: 'counter',
          instrumentationScope: { name: 'meter1', version: '1.0.0', schemaUrl: '' },
          data: [{
            attributes: { env: 'test', count: 5, enabled: true },
            startTimeUnixNano: '1000000000',
            timeUnixNano: '2000000000',
            value: 42
          }]
        },
        // UpDownCounter with negative value
        {
          name: 'test.updowncounter',
          type: 'updowncounter',
          instrumentationScope: { name: 'meter1', version: '1.0.0', schemaUrl: '' },
          data: [{ attributes: {}, timeUnixNano: '3000000000', value: -10 }]
        },
        // Histogram with boundaries
        {
          name: 'test.histogram',
          description: '',
          unit: '',
          type: 'histogram',
          instrumentationScope: { name: 'meter2', version: '2.0.0', schemaUrl: 'https://schema' },
          data: [{
            attributes: { endpoint: '/api' },
            startTimeUnixNano: '1000000000',
            timeUnixNano: '2000000000',
            count: 5,
            sum: 250.5,
            min: 10.5,
            max: 100.0,
            bucketCounts: [1, 2, 1, 1],
            explicitBounds: [10, 50, 100]
          }]
        },
        // Gauge with double value
        {
          name: 'test.gauge',
          type: 'gauge',
          instrumentationScope: { name: 'meter2', version: '2.0.0', schemaUrl: 'https://schema' },
          data: [{ attributes: {}, timeUnixNano: '4000000000', value: 75.5 }]
        }
      ]

      const buffer = transformer.transformMetrics(metrics)
      const decoded = protoMetricsService.decode(buffer)

      // Verify resource
      const resource = decoded.resourceMetrics[0].resource
      assert(resource.attributes.find(a => a.key === 'service.name').value.stringValue === 'test-service')

      // Verify multiple scopes
      const scopeMetrics = decoded.resourceMetrics[0].scopeMetrics
      assert.strictEqual(scopeMetrics.length, 2)
      assert.strictEqual(scopeMetrics[0].scope.name, 'meter1')
      assert.strictEqual(scopeMetrics[1].scope.name, 'meter2')

      // Verify counter
      const counter = scopeMetrics[0].metrics[0]
      assert.strictEqual(counter.name, 'test.counter')
      assert.strictEqual(counter.sum.isMonotonic, true)
      const counterValue = typeof counter.sum.dataPoints[0].asInt === 'object'
        ? counter.sum.dataPoints[0].asInt.toNumber()
        : counter.sum.dataPoints[0].asInt
      assert.strictEqual(counterValue, 42)

      // Verify attributes with different types
      const attrs = counter.sum.dataPoints[0].attributes
      assert(attrs.find(a => a.key === 'env').value.stringValue === 'test')
      assert(attrs.find(a => a.key === 'enabled').value.boolValue === true)

      // Verify updowncounter
      const updown = scopeMetrics[0].metrics[1]
      assert.strictEqual(updown.sum.isMonotonic, false)

      // Verify histogram
      const histogram = scopeMetrics[1].metrics[0]
      assert(histogram.histogram)
      assert.strictEqual(histogram.histogram.dataPoints[0].sum, 250.5)

      // Verify gauge with double
      const gauge = scopeMetrics[1].metrics[1]
      assert(gauge.gauge)
      assert.strictEqual(gauge.gauge.dataPoints[0].asDouble, 75.5)
    })

    it('handles missing optional fields', () => {
      const metrics = [{
        name: 'minimal',
        type: 'counter',
        data: [{ timeUnixNano: '1000000000', value: 1 }]
      }]

      const buffer = transformer.transformMetrics(metrics)
      const decoded = protoMetricsService.decode(buffer)
      const metric = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]

      assert.strictEqual(metric.description, '')
      assert.strictEqual(metric.unit, '')
      assert.strictEqual(decoded.resourceMetrics[0].scopeMetrics[0].scope.name, '')
    })

    it('handles complex attribute types', () => {
      const metrics = [{
        name: 'complex.attrs',
        type: 'counter',
        instrumentationScope: { name: 'test', version: '1.0.0', schemaUrl: '' },
        data: [{
          attributes: {
            string: 'value',
            number: 42,
            float: 3.14,
            boolean: true,
            array: [1, 2, 3],
            object: { nested: 'value' },
            null: null,
            undefined
          },
          timeUnixNano: '1000000000',
          value: 1
        }]
      }]

      const buffer = transformer.transformMetrics(metrics)
      const decoded = protoMetricsService.decode(buffer)
      const attrs = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes

      assert(attrs.find(a => a.key === 'string').value.stringValue === 'value')
      assert(attrs.find(a => a.key === 'boolean').value.boolValue === true)
      assert(attrs.find(a => a.key === 'array').value.arrayValue)
      assert(attrs.find(a => a.key === 'object').value.kvlistValue)
    })
  })

  describe('OtlpTransformer - JSON', () => {
    beforeEach(() => {
      transformer = new OtlpTransformer(resourceAttributes, 'http/json')
    })

    it('transforms all metric types to JSON with proper string conversions', () => {
      const metrics = [
        // Counter with integer
        {
          name: 'json.counter',
          description: 'JSON counter',
          unit: 'ops',
          type: 'counter',
          instrumentationScope: { name: 'meter', version: '1.0', schemaUrl: '' },
          data: [{
            attributes: { key: 'value' },
            startTimeUnixNano: '1000000000',
            timeUnixNano: '2000000000',
            value: 100
          }]
        },
        // UpDownCounter with double
        {
          name: 'json.updowncounter',
          type: 'updowncounter',
          instrumentationScope: { name: 'meter', version: '1.0', schemaUrl: '' },
          data: [{
            attributes: {},
            startTimeUnixNano: '1000000000',
            timeUnixNano: '2000000000',
            value: 3.14
          }]
        },
        // Histogram
        {
          name: 'json.histogram',
          type: 'histogram',
          instrumentationScope: { name: 'meter', version: '1.0', schemaUrl: '' },
          data: [{
            attributes: { route: '/test' },
            startTimeUnixNano: '1000000000',
            timeUnixNano: '2000000000',
            count: 10,
            sum: 500.25,
            min: 5.0,
            max: 100.0,
            bucketCounts: [2, 5, 3],
            explicitBounds: [10, 50]
          }]
        },
        // Gauge with integer
        {
          name: 'json.gauge',
          type: 'gauge',
          instrumentationScope: { name: 'meter', version: '1.0', schemaUrl: '' },
          data: [{ attributes: {}, timeUnixNano: '3000000000', value: 50 }]
        }
      ]

      const buffer = transformer.transformMetrics(metrics)
      const decoded = JSON.parse(buffer.toString())
      const metricsData = decoded.resourceMetrics[0].scopeMetrics[0].metrics

      // Verify counter - integer as string
      assert.strictEqual(metricsData[0].name, 'json.counter')
      assert.strictEqual(metricsData[0].sum.isMonotonic, true)
      assert.strictEqual(metricsData[0].sum.aggregationTemporality, 'AGGREGATION_TEMPORALITY_DELTA')
      assert.strictEqual(metricsData[0].sum.dataPoints[0].asInt, '100')
      assert.strictEqual(metricsData[0].sum.dataPoints[0].startTimeUnixNano, '1000000000')

      // Verify updowncounter - double as number
      assert.strictEqual(metricsData[1].sum.isMonotonic, false)
      assert.strictEqual(metricsData[1].sum.dataPoints[0].asDouble, 3.14)

      // Verify histogram - proper string conversions
      const histogramDp = metricsData[2].histogram.dataPoints[0]
      assert.strictEqual(histogramDp.count, '10')
      assert.strictEqual(histogramDp.sum, 500.25)
      assert.deepStrictEqual(histogramDp.bucketCounts, ['2', '5', '3'])
      assert.deepStrictEqual(histogramDp.explicitBounds, [10, 50])
      assert.strictEqual(histogramDp.timeUnixNano, '2000000000')

      // Verify gauge
      assert(metricsData[3].gauge)
      assert.strictEqual(metricsData[3].gauge.dataPoints[0].asInt, '50')
    })

    it('handles data points without startTimeUnixNano', () => {
      const metrics = [{
        name: 'no.start',
        type: 'gauge',
        instrumentationScope: { name: 'm', version: '1', schemaUrl: '' },
        data: [{ attributes: {}, timeUnixNano: '1000000000', value: 42 }]
      }]

      const buffer = transformer.transformMetrics(metrics)
      const decoded = JSON.parse(buffer.toString())
      const dp = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0]

      assert.strictEqual(dp.startTimeUnixNano, undefined)
      assert.strictEqual(dp.timeUnixNano, '1000000000')
    })

    it('handles histogram without bucketCounts or explicitBounds', () => {
      const metrics = [{
        name: 'minimal.histogram',
        type: 'histogram',
        instrumentationScope: { name: 'm', version: '1', schemaUrl: '' },
        data: [{
          attributes: {},
          startTimeUnixNano: '1000000000',
          timeUnixNano: '2000000000',
          count: 3,
          sum: 15.5,
          min: 2.0,
          max: 10.0
        }]
      }]

      const buffer = transformer.transformMetrics(metrics)
      const decoded = JSON.parse(buffer.toString())
      const histogramDp = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0]

      assert.deepStrictEqual(histogramDp.bucketCounts, [])
      assert.deepStrictEqual(histogramDp.explicitBounds, [])
    })
  })

  describe('OtlpHttpMetricExporter - Configuration', () => {
    it('parses URL components and sets default path', () => {
      const exporter = new OtlpHttpMetricExporter(
        'http://collector.example.com:4318/',
        'x-api-key=secret,authorization=Bearer token',
        5000,
        'http/protobuf',
        resourceAttributes
      )

      assert.strictEqual(exporter.options.hostname, 'collector.example.com')
      assert.strictEqual(exporter.options.port, '4318')
      assert.strictEqual(exporter.options.path, '/v1/metrics')
      assert.strictEqual(exporter.options.timeout, 5000)
      assert.strictEqual(exporter.options.headers['Content-Type'], 'application/x-protobuf')
      assert.strictEqual(exporter.options.headers['x-api-key'], 'secret')
      assert.strictEqual(exporter.options.headers.authorization, 'Bearer token')
    })

    it('uses custom path when provided', () => {
      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/custom/metrics?token=abc',
        '',
        10000,
        'http/json',
        resourceAttributes
      )

      assert.strictEqual(exporter.options.path, '/custom/metrics?token=abc')
      assert.strictEqual(exporter.options.headers['Content-Type'], 'application/json')
    })
  })

  describe('Metrics Export', () => {
    it('exports metrics with complete OTLP structure using protobuf', (done) => {
      const validator = mockOtlpExport((decoded, capturedHeaders) => {
        assert.strictEqual(capturedHeaders['Content-Type'], 'application/x-protobuf')

        // Validate resource
        const { resource } = decoded.resourceMetrics[0]
        const resourceAttrs = {}
        resource.attributes.forEach(attr => {
          resourceAttrs[attr.key] = attr.value.stringValue || attr.value.intValue
        })
        assert.strictEqual(resourceAttrs['service.name'], 'test-service')

        // Validate scope metrics
        const { scopeMetrics } = decoded.resourceMetrics[0]
        assert.strictEqual(scopeMetrics.length, 1)
        assert.strictEqual(scopeMetrics[0].scope.name, 'test-meter')
        assert.strictEqual(scopeMetrics[0].scope.version, '1.0.0')

        // Validate metric data
        const counter = scopeMetrics[0].metrics[0]
        assert.strictEqual(counter.name, 'test.requests')
        assert.strictEqual(counter.sum.isMonotonic, true)
        assert.strictEqual(counter.sum.dataPoints.length, 2)
      })

      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        '',
        5000,
        'http/protobuf',
        resourceAttributes
      )

      const metrics = [{
        name: 'test.requests',
        description: 'Test counter',
        unit: 'requests',
        type: 'counter',
        instrumentationScope: { name: 'test-meter', version: '1.0.0', schemaUrl: '' },
        data: [
          { attributes: { method: 'GET' }, startTimeUnixNano: '1000000000', timeUnixNano: '2000000000', value: 1 },
          { attributes: { method: 'POST' }, startTimeUnixNano: '1000000000', timeUnixNano: '2000000000', value: 2 }
        ]
      }]

      exporter.export(metrics, (result) => {
        assert.strictEqual(result.code, 0)
        validator()
        done()
      })
    })

    it('exports metrics using JSON protocol', (done) => {
      const validator = mockOtlpExport((decoded, capturedHeaders) => {
        assert.strictEqual(capturedHeaders['Content-Type'], 'application/json')
        assert.strictEqual(decoded.resourceMetrics[0].scopeMetrics[0].metrics[0].name, 'json.counter')
        assert.strictEqual(decoded.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt, '42')
      }, 'json')

      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        '',
        5000,
        'http/json',
        resourceAttributes
      )

      const metrics = [{
        name: 'json.counter',
        type: 'counter',
        instrumentationScope: { name: 'json-meter', version: '1.0.0', schemaUrl: '' },
        data: [{ attributes: {}, timeUnixNano: '2000000000', value: 42 }]
      }]

      exporter.export(metrics, (result) => {
        assert.strictEqual(result.code, 0)
        validator()
        done()
      })
    })

    it('exports all metric types correctly', (done) => {
      const validator = mockOtlpExport((decoded) => {
        const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics

        const counter = metrics.find(m => m.name === 'all.types.counter')
        assert(counter)
        assert.strictEqual(counter.sum.isMonotonic, true)

        const upDownCounter = metrics.find(m => m.name === 'all.types.updowncounter')
        assert(upDownCounter)
        assert.strictEqual(upDownCounter.sum.isMonotonic, false)

        const histogram = metrics.find(m => m.name === 'all.types.histogram')
        assert(histogram)
        assert(histogram.histogram)

        const gauge = metrics.find(m => m.name === 'all.types.gauge')
        assert(gauge)
        assert(gauge.gauge)
      })

      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        '',
        5000,
        'http/protobuf',
        resourceAttributes
      )

      const metrics = [
        {
          name: 'all.types.counter',
          type: 'counter',
          instrumentationScope: { name: 'all-types-meter', version: '1.0.0', schemaUrl: '' },
          data: [{ attributes: {}, timeUnixNano: '2000000000', value: 10 }]
        },
        {
          name: 'all.types.updowncounter',
          type: 'updowncounter',
          instrumentationScope: { name: 'all-types-meter', version: '1.0.0', schemaUrl: '' },
          data: [{ attributes: {}, timeUnixNano: '2000000000', value: -2 }]
        },
        {
          name: 'all.types.histogram',
          type: 'histogram',
          instrumentationScope: { name: 'all-types-meter', version: '1.0.0', schemaUrl: '' },
          data: [{
            attributes: {},
            startTimeUnixNano: '1000000000',
            timeUnixNano: '2000000000',
            count: 2,
            sum: 300,
            min: 100,
            max: 200,
            bucketCounts: [1, 1],
            explicitBounds: [150]
          }]
        },
        {
          name: 'all.types.gauge',
          type: 'gauge',
          instrumentationScope: { name: 'all-types-meter', version: '1.0.0', schemaUrl: '' },
          data: [{ attributes: {}, timeUnixNano: '2000000000', value: 75.5 }]
        }
      ]

      exporter.export(metrics, (result) => {
        assert.strictEqual(result.code, 0)
        validator()
        done()
      })
    })

    it('handles HTTP errors gracefully', (done) => {
      sinon.stub(http, 'request').callsFake((options, callback) => {
        const responseHandlers = {}
        const mockRes = {
          statusCode: 500,
          on: (event, handler) => {
            responseHandlers[event] = handler
            return mockRes
          },
          setTimeout: () => mockRes
        }

        const mockReq = {
          write: () => {},
          end: () => {
            // Trigger data and end events to complete the response
            if (responseHandlers.data) {
              responseHandlers.data('Internal Server Error')
            }
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
      })

      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        '',
        5000,
        'http/protobuf',
        resourceAttributes
      )

      const metrics = [{
        name: 'test',
        type: 'counter',
        instrumentationScope: { name: 't', version: '1', schemaUrl: '' },
        data: [{ attributes: {}, timeUnixNano: '1000000000', value: 1 }]
      }]

      exporter.export(metrics, (result) => {
        assert.strictEqual(result.code, 1)
        assert(result.error)
        done()
      })
    })

    it('returns success immediately for empty metrics array', (done) => {
      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        '',
        5000,
        'http/protobuf',
        resourceAttributes
      )

      exporter.export([], (result) => {
        assert.strictEqual(result.code, 0)
        done()
      })
    })

    it('handles connection errors gracefully', (done) => {
      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:1/', // Invalid port
        '',
        100,
        'http/protobuf',
        resourceAttributes
      )

      const testMetrics = [{
        name: 'test',
        type: 'counter',
        instrumentationScope: { name: 't', version: '1', schemaUrl: '' },
        data: [{ attributes: {}, timeUnixNano: '1000000000', value: 1 }]
      }]

      exporter.export(testMetrics, (result) => {
        assert.strictEqual(result.code, 1)
        assert(result.error)
        done()
      })
    })
  })
})
