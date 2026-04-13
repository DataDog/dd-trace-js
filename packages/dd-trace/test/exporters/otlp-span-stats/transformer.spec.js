'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

require('../../setup/core')
const OtlpStatsTransformer = require('../../../src/exporters/otlp-span-stats/transformer')
const { SpanAggStats, SpanAggKey } = require('../../../src/span_stats')

const { HTTP_STATUS_CODE, HTTP_ROUTE, HTTP_METHOD } = require('../../../../../ext/tags')

const NS_PER_SECOND = 1e9

// Build a minimal span fixture
const basicSpan = {
  startTime: 10000 * 1e9,
  duration: 5000,
  error: 0,
  name: 'http.request',
  service: 'web-service',
  resource: '/users',
  type: 'web',
  meta: {
    [HTTP_STATUS_CODE]: 200,
    [HTTP_METHOD]: 'GET',
    [HTTP_ROUTE]: '/users/:id',
  },
  metrics: {},
}

const errorSpan = {
  ...basicSpan,
  error: 1,
  meta: { ...basicSpan.meta, [HTTP_STATUS_CODE]: 500 },
}

const resourceAttributes = {
  'service.name': 'web-service',
  'deployment.environment': 'test',
  'service.version': '1.0.0',
  'host.name': 'my-host',
  'dd.runtime_id': 'abc-123',
}

/**
 * Builds a drained bucket entry with one aggregated span.
 *
 * @param {object} span
 * @param {number} timeNs
 * @returns {{ timeNs: number, bucket: Map }}
 */
function makeDrained (span, timeNs = 10000 * 1e9) {
  const aggKey = new SpanAggKey(span)
  const aggStats = new SpanAggStats(aggKey)
  aggStats.record(span)
  const bucket = new Map([[aggKey.toString(), aggStats]])
  return [{ timeNs, bucket }]
}

const BUCKET_SIZE_NS = 10 * 1e9

describe('OtlpStatsTransformer', () => {
  describe('JSON output (http/json protocol)', () => {
    let transformer

    it('should construct with http/json protocol', () => {
      transformer = new OtlpStatsTransformer(resourceAttributes, 'http/json', 'explicit')
      assert.strictEqual(transformer.protocol, 'http/json')
      assert.strictEqual(transformer.histogramType, 'explicit')
    })

    it('should emit a valid JSON buffer', () => {
      const drained = makeDrained(basicSpan)
      const result = transformer.transform(drained, BUCKET_SIZE_NS)
      assert.ok(Buffer.isBuffer(result))
      const parsed = JSON.parse(result.toString())
      assert.ok(Array.isArray(parsed.resourceMetrics))
    })

    it('should include resource attributes', () => {
      const drained = makeDrained(basicSpan)
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { resource } = parsed.resourceMetrics[0]
      const attrMap = Object.fromEntries(resource.attributes.map(a => [a.key, a.value.stringValue]))
      assert.strictEqual(attrMap['service.name'], 'web-service')
      assert.strictEqual(attrMap['deployment.environment'], 'test')
      assert.strictEqual(attrMap['host.name'], 'my-host')
      assert.strictEqual(attrMap['dd.runtime_id'], 'abc-123')
    })

    it('should include dd-trace instrumentation scope', () => {
      const drained = makeDrained(basicSpan)
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { scope } = parsed.resourceMetrics[0].scopeMetrics[0]
      assert.strictEqual(scope.name, 'dd-trace')
      assert.ok(typeof scope.version === 'string')
    })

    it('should emit exactly four metrics', () => {
      const drained = makeDrained(basicSpan)
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { metrics } = parsed.resourceMetrics[0].scopeMetrics[0]
      const names = metrics.map(m => m.name)
      assert.deepStrictEqual(names.sort(), [
        'dd.trace.span.duration',
        'dd.trace.span.errors',
        'dd.trace.span.hits',
        'dd.trace.span.top_level_hits',
      ])
    })

    it('should set correct units on all metrics', () => {
      const drained = makeDrained(basicSpan)
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { metrics } = parsed.resourceMetrics[0].scopeMetrics[0]
      const unitMap = Object.fromEntries(metrics.map(m => [m.name, m.unit]))
      assert.strictEqual(unitMap['dd.trace.span.hits'], '{span}')
      assert.strictEqual(unitMap['dd.trace.span.errors'], '{span}')
      assert.strictEqual(unitMap['dd.trace.span.top_level_hits'], '{span}')
      assert.strictEqual(unitMap['dd.trace.span.duration'], 's')
    })

    it('should set delta temporality on Sum metrics', () => {
      const drained = makeDrained(basicSpan)
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { metrics } = parsed.resourceMetrics[0].scopeMetrics[0]
      for (const metric of metrics.filter(m => m.sum)) {
        assert.strictEqual(metric.sum.aggregationTemporality, 'AGGREGATION_TEMPORALITY_DELTA')
        assert.strictEqual(metric.sum.isMonotonic, true)
      }
    })

    it('should set delta temporality on Histogram metric', () => {
      const drained = makeDrained(basicSpan)
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { metrics } = parsed.resourceMetrics[0].scopeMetrics[0]
      const duration = metrics.find(m => m.name === 'dd.trace.span.duration')
      assert.strictEqual(duration.histogram.aggregationTemporality, 'AGGREGATION_TEMPORALITY_DELTA')
    })

    it('should set correct hit counts on dd.trace.span.hits', () => {
      const drained = makeDrained(basicSpan)
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const hits = parsed.resourceMetrics[0].scopeMetrics[0].metrics.find(m => m.name === 'dd.trace.span.hits')
      assert.strictEqual(hits.sum.dataPoints[0].asInt, 1)
    })

    it('should set correct error counts on dd.trace.span.errors for non-error span', () => {
      const drained = makeDrained(basicSpan)
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const errors = parsed.resourceMetrics[0].scopeMetrics[0].metrics.find(m => m.name === 'dd.trace.span.errors')
      assert.strictEqual(errors.sum.dataPoints[0].asInt, 0)
    })

    it('should set correct error counts for error span', () => {
      const drained = makeDrained(errorSpan)
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const errors = parsed.resourceMetrics[0].scopeMetrics[0].metrics.find(m => m.name === 'dd.trace.span.errors')
      assert.strictEqual(errors.sum.dataPoints[0].asInt, 1)
    })

    it('should include correct dimension attributes on data points', () => {
      const drained = makeDrained(basicSpan)
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const hits = parsed.resourceMetrics[0].scopeMetrics[0].metrics.find(m => m.name === 'dd.trace.span.hits')
      const dp = hits.sum.dataPoints[0]
      // attributesToJson converts all values to stringValue
      const attrMap = Object.fromEntries(dp.attributes.map(a => [a.key, a.value.stringValue]))
      assert.strictEqual(attrMap['span.name'], 'http.request')
      assert.strictEqual(attrMap['dd.resource'], '/users')
      assert.strictEqual(attrMap['dd.span.type'], 'web')
      assert.strictEqual(attrMap['http.response.status_code'], '200')
      assert.strictEqual(attrMap['http.request.method'], 'GET')
      assert.strictEqual(attrMap['http.route'], '/users/:id')
    })

    it('should emit duration histogram with seconds unit and correct count/sum/min/max', () => {
      const drained = makeDrained(basicSpan)
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const duration = parsed.resourceMetrics[0].scopeMetrics[0].metrics.find(m => m.name === 'dd.trace.span.duration')
      const dp = duration.histogram.dataPoints.find(d => {
        const errAttr = d.attributes.find(a => a.key === 'error')
        return errAttr && errAttr.value.stringValue === 'false'
      })
      assert.ok(dp)
      assert.strictEqual(dp.count, 1)
      assert.strictEqual(dp.sum, basicSpan.duration / NS_PER_SECOND)
      assert.strictEqual(dp.min, basicSpan.duration / NS_PER_SECOND)
      assert.strictEqual(dp.max, basicSpan.duration / NS_PER_SECOND)
    })

    it('should split duration histogram by error=true and error=false', () => {
      // Span with both ok and error sub-spans
      const aggKey = new SpanAggKey(basicSpan)
      const aggStats = new SpanAggStats(aggKey)
      aggStats.record(basicSpan) // ok span
      aggStats.record(errorSpan) // error span
      const bucket = new Map([[aggKey.toString(), aggStats]])
      const drained = [{ timeNs: 10000 * 1e9, bucket }]

      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const duration = parsed.resourceMetrics[0].scopeMetrics[0].metrics.find(m => m.name === 'dd.trace.span.duration')
      const errorDp = duration.histogram.dataPoints.find(d =>
        d.attributes.find(a => a.key === 'error' && a.value.stringValue === 'true')
      )
      const okDp = duration.histogram.dataPoints.find(d =>
        d.attributes.find(a => a.key === 'error' && a.value.stringValue === 'false')
      )
      assert.ok(errorDp, 'should have error=true data point')
      assert.ok(okDp, 'should have error=false data point')
      assert.strictEqual(errorDp.count, 1)
      assert.strictEqual(okDp.count, 1)
    })

    it('should omit error data point when no errors', () => {
      const drained = makeDrained(basicSpan)
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const duration = parsed.resourceMetrics[0].scopeMetrics[0].metrics.find(m => m.name === 'dd.trace.span.duration')
      const errorDp = duration.histogram.dataPoints.find(d =>
        d.attributes.find(a => a.key === 'error' && a.value.stringValue === 'true')
      )
      assert.strictEqual(errorDp, undefined)
    })

    it('should set startTimeUnixNano and timeUnixNano as strings in JSON', () => {
      const drained = makeDrained(basicSpan)
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const hits = parsed.resourceMetrics[0].scopeMetrics[0].metrics.find(m => m.name === 'dd.trace.span.hits')
      const dp = hits.sum.dataPoints[0]
      assert.strictEqual(typeof dp.startTimeUnixNano, 'string')
      assert.strictEqual(typeof dp.timeUnixNano, 'string')
    })

    it('should handle multiple time buckets', () => {
      const aggKey1 = new SpanAggKey(basicSpan)
      const aggStats1 = new SpanAggStats(aggKey1)
      aggStats1.record(basicSpan)
      const bucket1 = new Map([[aggKey1.toString(), aggStats1]])

      const aggKey2 = new SpanAggKey(errorSpan)
      const aggStats2 = new SpanAggStats(aggKey2)
      aggStats2.record(errorSpan)
      const bucket2 = new Map([[aggKey2.toString(), aggStats2]])

      const drained = [
        { timeNs: 10000 * 1e9, bucket: bucket1 },
        { timeNs: 20000 * 1e9, bucket: bucket2 },
      ]

      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const hits = parsed.resourceMetrics[0].scopeMetrics[0].metrics.find(m => m.name === 'dd.trace.span.hits')
      assert.strictEqual(hits.sum.dataPoints.length, 2)
    })
  })

  describe('Protobuf output (http/protobuf protocol)', () => {
    let transformer

    it('should construct with http/protobuf protocol', () => {
      transformer = new OtlpStatsTransformer(resourceAttributes, 'http/protobuf', 'explicit')
      assert.strictEqual(transformer.protocol, 'http/protobuf')
    })

    it('should emit a non-empty Buffer', () => {
      const drained = makeDrained(basicSpan)
      const result = transformer.transform(drained, BUCKET_SIZE_NS)
      assert.ok(Buffer.isBuffer(result))
      assert.ok(result.length > 0)
    })

    it('should emit a different encoding than JSON', () => {
      const drained = makeDrained(basicSpan)
      const jsonTransformer = new OtlpStatsTransformer(resourceAttributes, 'http/json', 'explicit')
      const protoResult = transformer.transform(drained, BUCKET_SIZE_NS)
      const jsonResult = jsonTransformer.transform(drained, BUCKET_SIZE_NS)
      assert.notDeepStrictEqual(protoResult, jsonResult)
    })
  })

  describe('gRPC protocol fallback', () => {
    it('should fall back to http/protobuf when grpc is configured', () => {
      // OtlpTransformerBase logs a warning and falls back when grpc is requested
      const grpcTransformer = new OtlpStatsTransformer(resourceAttributes, 'grpc', 'explicit')
      assert.strictEqual(grpcTransformer.protocol, 'http/protobuf')
    })
  })

  describe('empty input', () => {
    it('should handle empty drained array', () => {
      const transformer = new OtlpStatsTransformer(resourceAttributes, 'http/json', 'explicit')
      const result = JSON.parse(transformer.transform([], BUCKET_SIZE_NS).toString())
      const { metrics } = result.resourceMetrics[0].scopeMetrics[0]
      for (const metric of metrics) {
        if (metric.sum) assert.strictEqual(metric.sum.dataPoints.length, 0)
        if (metric.histogram) assert.strictEqual(metric.histogram.dataPoints.length, 0)
      }
    })

    it('should handle bucket with no entries', () => {
      const transformer = new OtlpStatsTransformer(resourceAttributes, 'http/json', 'explicit')
      const emptyBucket = new Map()
      const drained = [{ timeNs: 10000 * 1e9, bucket: emptyBucket }]
      const result = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { metrics } = result.resourceMetrics[0].scopeMetrics[0]
      for (const metric of metrics) {
        if (metric.sum) assert.strictEqual(metric.sum.dataPoints.length, 0)
      }
    })
  })

  describe('DDSketch with multiple accepted values', () => {
    it('should sum duration values correctly', () => {
      const aggKey = new SpanAggKey(basicSpan)
      const aggStats = new SpanAggStats(aggKey)
      const durations = [1000, 2000, 3000, 4000]
      for (const d of durations) {
        aggStats.record({ ...basicSpan, duration: d })
      }

      const bucket = new Map([[aggKey.toString(), aggStats]])
      const drained = [{ timeNs: 10000 * 1e9, bucket }]
      const transformer = new OtlpStatsTransformer(resourceAttributes, 'http/json', 'explicit')
      const parsed = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const duration = parsed.resourceMetrics[0].scopeMetrics[0].metrics.find(m => m.name === 'dd.trace.span.duration')
      const okDp = duration.histogram.dataPoints.find(d =>
        d.attributes.find(a => a.key === 'error' && a.value.stringValue === 'false')
      )

      assert.ok(okDp)
      assert.strictEqual(okDp.count, 4)
      // sum should be (1000+2000+3000+4000) / 1e9 seconds
      assert.ok(Math.abs(okDp.sum - (10000 / NS_PER_SECOND)) < 1e-10)
    })
  })
})
