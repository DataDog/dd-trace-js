'use strict'

const assert = require('assert')
const { describe, it, beforeEach } = require('tap').mocha
require('../setup/core')
const OtlpTransformer = require('../../src/opentelemetry/metrics/otlp_transformer')
const OtlpHttpMetricExporter = require('../../src/opentelemetry/metrics/otlp_http_metric_exporter')
const { protoMetricsService } = require('../../src/opentelemetry/otlp/protobuf_loader').getProtobufTypes()

describe('OpenTelemetry Metrics - OTLP Transform and Export', () => {
  let transformer
  let resourceAttributes

  beforeEach(() => {
    resourceAttributes = {
      'service.name': 'test-service',
      'service.version': '1.0.0',
      'telemetry.sdk.name': 'dd-trace-js',
      'telemetry.sdk.language': 'nodejs'
    }
  })

  describe('OtlpTransformer', () => {
    describe('Protobuf Protocol', () => {
      beforeEach(() => {
        transformer = new OtlpTransformer(resourceAttributes, 'http/protobuf')
      })

      it('transforms Counter metric to OTLP protobuf format', () => {
        const metrics = [{
          name: 'test.counter',
          description: 'A test counter',
          unit: 'operations',
          type: 'counter',
          instrumentationScope: {
            name: 'test-meter',
            version: '1.0.0',
            schemaUrl: ''
          },
          data: [{
            attributes: { environment: 'test' },
            startTimeUnixNano: '1000000000',
            timeUnixNano: '2000000000',
            value: 42
          }]
        }]

        const buffer = transformer.transformMetrics(metrics)
        assert(Buffer.isBuffer(buffer), 'Should return a Buffer')

        const decoded = protoMetricsService.decode(buffer)
        const metric = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]

        assert.strictEqual(metric.name, 'test.counter')
        assert.strictEqual(metric.description, 'A test counter')
        assert.strictEqual(metric.unit, 'operations')
        assert(metric.sum, 'Should have sum data')
        assert.strictEqual(metric.sum.isMonotonic, true)
        assert.strictEqual(metric.sum.dataPoints.length, 1)

        const dataPoint = metric.sum.dataPoints[0]
        const value = typeof dataPoint.asInt === 'object' ? dataPoint.asInt.toNumber() : dataPoint.asInt
        assert.strictEqual(value, 42)
      })

      it('transforms UpDownCounter metric to OTLP protobuf format', () => {
        const metrics = [{
          name: 'test.updowncounter',
          description: 'A test updowncounter',
          unit: 'items',
          type: 'updowncounter',
          instrumentationScope: {
            name: 'test-meter',
            version: '1.0.0',
            schemaUrl: ''
          },
          data: [{
            attributes: { queue: 'main' },
            startTimeUnixNano: '1000000000',
            timeUnixNano: '2000000000',
            value: -10
          }]
        }]

        const buffer = transformer.transformMetrics(metrics)
        const decoded = protoMetricsService.decode(buffer)
        const metric = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]

        assert.strictEqual(metric.name, 'test.updowncounter')
        assert(metric.sum, 'Should have sum data')
        assert.strictEqual(metric.sum.isMonotonic, false, 'UpDownCounter should not be monotonic')

        const dataPoint = metric.sum.dataPoints[0]
        const value = typeof dataPoint.asInt === 'object' ? dataPoint.asInt.toNumber() : dataPoint.asInt
        assert.strictEqual(value, -10)
      })

      it('transforms Histogram metric to OTLP protobuf format', () => {
        const metrics = [{
          name: 'test.histogram',
          description: 'A test histogram',
          unit: 'ms',
          type: 'histogram',
          instrumentationScope: {
            name: 'test-meter',
            version: '1.0.0',
            schemaUrl: ''
          },
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
        }]

        const buffer = transformer.transformMetrics(metrics)
        const decoded = protoMetricsService.decode(buffer)
        const metric = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]

        assert.strictEqual(metric.name, 'test.histogram')
        assert(metric.histogram, 'Should have histogram data')
        assert.strictEqual(metric.histogram.dataPoints.length, 1)

        const dataPoint = metric.histogram.dataPoints[0]
        const count = typeof dataPoint.count === 'object' ? dataPoint.count.toNumber() : dataPoint.count
        assert.strictEqual(count, 5)
        assert.strictEqual(dataPoint.sum, 250.5)
        assert(Array.isArray(dataPoint.bucketCounts))
        assert(Array.isArray(dataPoint.explicitBounds))
      })

      it('transforms Gauge metric to OTLP protobuf format', () => {
        const metrics = [{
          name: 'test.gauge',
          description: 'A test gauge',
          unit: 'percent',
          type: 'gauge',
          instrumentationScope: {
            name: 'test-meter',
            version: '1.0.0',
            schemaUrl: ''
          },
          data: [{
            attributes: { resource: 'cpu' },
            timeUnixNano: '2000000000',
            value: 75.5
          }]
        }]

        const buffer = transformer.transformMetrics(metrics)
        const decoded = protoMetricsService.decode(buffer)
        const metric = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]

        assert.strictEqual(metric.name, 'test.gauge')
        assert(metric.gauge, 'Should have gauge data')
        assert.strictEqual(metric.gauge.dataPoints.length, 1)

        const dataPoint = metric.gauge.dataPoints[0]
        assert.strictEqual(dataPoint.asDouble, 75.5)
      })

      it('validates OTLP resource structure', () => {
        const metrics = [{
          name: 'test.metric',
          type: 'counter',
          instrumentationScope: { name: 'test', version: '1.0.0', schemaUrl: '' },
          data: [{ attributes: {}, timeUnixNano: '1000000000', value: 1 }]
        }]

        const buffer = transformer.transformMetrics(metrics)
        const decoded = protoMetricsService.decode(buffer)

        assert(decoded.resourceMetrics, 'Should have resourceMetrics')
        assert.strictEqual(decoded.resourceMetrics.length, 1)

        const resource = decoded.resourceMetrics[0].resource
        assert(resource, 'Should have resource')
        assert(Array.isArray(resource.attributes), 'Should have resource attributes')

        const serviceNameAttr = resource.attributes.find(attr => attr.key === 'service.name')
        assert(serviceNameAttr, 'Should have service.name attribute')
        assert.strictEqual(serviceNameAttr.value.stringValue, 'test-service')
      })

      it('validates scope metrics structure', () => {
        const metrics = [{
          name: 'test.metric',
          type: 'counter',
          instrumentationScope: {
            name: 'custom-meter',
            version: '2.0.0',
            schemaUrl: 'https://example.com/schema'
          },
          data: [{ attributes: {}, timeUnixNano: '1000000000', value: 1 }]
        }]

        const buffer = transformer.transformMetrics(metrics)
        const decoded = protoMetricsService.decode(buffer)

        const scopeMetrics = decoded.resourceMetrics[0].scopeMetrics
        assert(Array.isArray(scopeMetrics))
        assert.strictEqual(scopeMetrics.length, 1)

        const scope = scopeMetrics[0].scope
        assert.strictEqual(scope.name, 'custom-meter')
        assert.strictEqual(scope.version, '2.0.0')
      })

      it('validates data point attributes', () => {
        const metrics = [{
          name: 'test.counter',
          type: 'counter',
          instrumentationScope: { name: 'test', version: '1.0.0', schemaUrl: '' },
          data: [{
            attributes: {
              environment: 'production',
              region: 'us-east-1',
              count: 5
            },
            timeUnixNano: '1000000000',
            value: 1
          }]
        }]

        const buffer = transformer.transformMetrics(metrics)
        const decoded = protoMetricsService.decode(buffer)

        const dataPoint = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]
        assert(Array.isArray(dataPoint.attributes))

        const envAttr = dataPoint.attributes.find(attr => attr.key === 'environment')
        assert(envAttr)
        assert.strictEqual(envAttr.value.stringValue, 'production')

        const countAttr = dataPoint.attributes.find(attr => attr.key === 'count')
        assert(countAttr)
        const countValue = typeof countAttr.value.intValue === 'object'
          ? countAttr.value.intValue.toNumber()
          : countAttr.value.intValue
        assert.strictEqual(countValue, 5)
      })
    })

    describe('JSON Protocol', () => {
      beforeEach(() => {
        transformer = new OtlpTransformer(resourceAttributes, 'http/json')
      })

      it('transforms Counter metric to OTLP JSON format', () => {
        const metrics = [{
          name: 'test.counter',
          description: 'A test counter',
          unit: 'operations',
          type: 'counter',
          instrumentationScope: {
            name: 'test-meter',
            version: '1.0.0',
            schemaUrl: ''
          },
          data: [{
            attributes: { environment: 'test' },
            startTimeUnixNano: '1000000000',
            timeUnixNano: '2000000000',
            value: 42
          }]
        }]

        const buffer = transformer.transformMetrics(metrics)
        const decoded = JSON.parse(buffer.toString())
        const metric = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]

        assert.strictEqual(metric.name, 'test.counter')
        assert.strictEqual(metric.description, 'A test counter')
        assert.strictEqual(metric.unit, 'operations')
        assert(metric.sum)
        assert.strictEqual(metric.sum.isMonotonic, true)
        assert.strictEqual(metric.sum.dataPoints[0].asInt, '42')
      })

      it('validates JSON format structure', () => {
        const metrics = [{
          name: 'test.metric',
          type: 'counter',
          instrumentationScope: { name: 'test', version: '1.0.0', schemaUrl: '' },
          data: [{ attributes: {}, timeUnixNano: '1000000000', value: 1 }]
        }]

        const buffer = transformer.transformMetrics(metrics)
        const decoded = JSON.parse(buffer.toString())

        assert(decoded.resourceMetrics)
        assert(Array.isArray(decoded.resourceMetrics))
        assert(decoded.resourceMetrics[0].resource)
        assert(Array.isArray(decoded.resourceMetrics[0].scopeMetrics))
      })
    })

    describe('Protocol Handling', () => {
      it('defaults to protobuf protocol', () => {
        transformer = new OtlpTransformer(resourceAttributes, 'http/protobuf')
        assert.strictEqual(transformer.protocol, 'http/protobuf')
      })

      it('supports JSON protocol', () => {
        transformer = new OtlpTransformer(resourceAttributes, 'http/json')
        assert.strictEqual(transformer.protocol, 'http/json')
      })

      it('falls back to protobuf for gRPC protocol', () => {
        transformer = new OtlpTransformer(resourceAttributes, 'grpc')
        assert.strictEqual(transformer.protocol, 'http/protobuf')
      })
    })
  })

  describe('OtlpHttpMetricExporter', () => {
    it('constructs with correct default path', () => {
      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        '',
        10000,
        'http/protobuf',
        resourceAttributes
      )

      assert.strictEqual(exporter.options.hostname, 'localhost')
      assert.strictEqual(exporter.options.port, '4318')
      assert.strictEqual(exporter.options.path, '/v1/metrics')
      assert.strictEqual(exporter.options.headers['Content-Type'], 'application/x-protobuf')
    })

    it('constructs with custom path', () => {
      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/custom/path',
        '',
        10000,
        'http/protobuf',
        resourceAttributes
      )

      assert.strictEqual(exporter.options.path, '/custom/path')
    })

    it('sets JSON content type for JSON protocol', () => {
      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        '',
        10000,
        'http/json',
        resourceAttributes
      )

      assert.strictEqual(exporter.options.headers['Content-Type'], 'application/json')
    })

    it('parses additional headers correctly', () => {
      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        'api-key=secret123,x-custom=value',
        10000,
        'http/protobuf',
        resourceAttributes
      )

      assert.strictEqual(exporter.options.headers['api-key'], 'secret123')
      assert.strictEqual(exporter.options.headers['x-custom'], 'value')
    })

    it('handles empty metrics array', (done) => {
      const exporter = new OtlpHttpMetricExporter(
        'http://localhost:4318/',
        '',
        10000,
        'http/protobuf',
        resourceAttributes
      )

      exporter.export([], (result) => {
        assert.strictEqual(result.code, 0)
        done()
      })
    })
  })
})
