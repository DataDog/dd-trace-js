'use strict'

const assert = require('node:assert/strict')
const { describe, it, before } = require('mocha')

require('../../setup/core')

const OtlpStatsTransformer = require('../../../src/exporters/otlp-span-stats/transformer')
const { EXPLICIT_BOUNDS_SECONDS } = OtlpStatsTransformer
const { SpanBuckets } = require('../../../src/span_stats')
const { getProtobufTypes } = require('../../../src/opentelemetry/otlp/protobuf_loader')
const { HTTP_STATUS_CODE, HTTP_METHOD, HTTP_ROUTE, SPAN_KIND } = require('../../../../../ext/tags')
const { ORIGIN_KEY, TOP_LEVEL_KEY } = require('../../../src/constants')

const METRIC_NAME = 'traces.span.sdk.metrics.duration'
const RESOURCE_ATTRS = { 'telemetry.sdk.name': 'datadog', 'telemetry.sdk.language': 'nodejs' }
const SCOPE_IDENTITY = { env: 'test', serviceVersion: '1.2.3' }
const BUCKET_SIZE_NS = 10 * 1e9

function makeSpan (overrides = {}) {
  return {
    startTime: 12345 * 1e9,
    duration: 1000,
    error: 0,
    name: 'test.op',
    service: 'svc',
    resource: 'GET /foo',
    type: 'web',
    meta: { [HTTP_STATUS_CODE]: 200 },
    metrics: {},
    ...overrides,
  }
}

function makeTopLevelSpan (overrides = {}) {
  return makeSpan({ metrics: { [TOP_LEVEL_KEY]: 1 }, ...overrides })
}

function makeBucket (spans) {
  const bucket = new SpanBuckets()
  for (const span of spans) {
    bucket.forSpan(span).record(span)
  }
  return bucket
}

function makeDrained (timeNs, spans) {
  return [{ timeNs, bucket: makeBucket(spans) }]
}

/**
 * @param {object} dataPoint
 * @returns {Record<string, string | number | boolean>}
 */
function attrMapOf (dataPoint) {
  return Object.fromEntries(dataPoint.attributes.map(a => {
    const v = a.value
    return [a.key, v.stringValue ?? v.boolValue ?? v.intValue ?? v.doubleValue]
  }))
}

function dataPointsOf (payload) {
  return payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints
}

describe('OtlpStatsTransformer', () => {
  let protoMetricsService
  let protoAggregationTemporality

  before(() => {
    ({ protoMetricsService, protoAggregationTemporality } = getProtobufTypes())
  })

  describe('JSON format (default mode)', () => {
    let transformer

    before(() => {
      transformer = new OtlpStatsTransformer(RESOURCE_ATTRS, 'http/json', false, SCOPE_IDENTITY)
    })

    it('emits a single histogram metric with the correct name, unit and temporality', () => {
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, [makeSpan()]), BUCKET_SIZE_NS))
      const { metrics } = payload.resourceMetrics[0].scopeMetrics[0]

      assert.strictEqual(metrics.length, 1)
      assert.deepStrictEqual(
        { name: metrics[0].name, unit: metrics[0].unit, temporality: metrics[0].histogram.aggregationTemporality },
        { name: METRIC_NAME, unit: 's', temporality: 'AGGREGATION_TEMPORALITY_DELTA' }
      )
    })

    it('maps span dimensions to OTel and dd.* data-point attributes', () => {
      const span = makeSpan({
        meta: {
          [HTTP_STATUS_CODE]: 404,
          [HTTP_METHOD]: 'POST',
          [HTTP_ROUTE]: '/users/:id',
          [SPAN_KIND]: 'server',
          'grpc.method.name': 'GetUser',
          'grpc.status.code': '0',
          [ORIGIN_KEY]: 'synthetics',
        },
      })
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, [span]), BUCKET_SIZE_NS))

      assert.deepStrictEqual(attrMapOf(dataPointsOf(payload)[0]), {
        'span.name': 'GET /foo',
        'span.kind': 'server',
        'http.response.status_code': 404,
        'http.request.method': 'POST',
        'http.route': '/users/:id',
        'rpc.method': 'GetUser',
        'rpc.response.status_code': 0,
        'dd.operation.name': 'test.op',
        'dd.span.type': 'web',
        'dd.origin': 'synthetics',
        'dd.span.top_level': false,
      })
    })

    it('translates a numeric grpc.status.code stored in span metrics to rpc.response.status_code', () => {
      // The gRPC plugin records the status code as a numeric tag, which span formatting routes into
      // metrics rather than meta; 0 (OK) is a common value and must still be emitted.
      const span = makeSpan({ meta: {}, metrics: { 'grpc.status.code': 0 } })
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, [span]), BUCKET_SIZE_NS))

      assert.strictEqual(attrMapOf(dataPointsOf(payload)[0])['rpc.response.status_code'], 0)
    })

    it('omits optional attributes when not present on the span', () => {
      const payload = JSON.parse(
        transformer.transform(makeDrained(12340000000000, [makeSpan({ meta: {} })]), BUCKET_SIZE_NS)
      )
      const keys = dataPointsOf(payload)[0].attributes.map(a => a.key)

      for (const key of ['http.response.status_code', 'http.request.method', 'http.route', 'span.kind', 'rpc.method']) {
        assert.ok(!keys.includes(key), `${key} should be omitted`)
      }
    })

    it('converts duration to seconds with fixed bounds and a sketch-derived distribution', () => {
      const spans = [makeSpan({ duration: 1e9 }), makeSpan({ duration: 3e9 })] // 1s and 3s, same group
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, spans), BUCKET_SIZE_NS))
      const dp = dataPointsOf(payload)[0]

      assert.strictEqual(dp.count, 2)
      assert.strictEqual(dp.min, 1)
      assert.strictEqual(dp.max, 3)
      assert.strictEqual(dp.sum, 4)
      assert.deepStrictEqual(dp.explicitBounds, EXPLICIT_BOUNDS_SECONDS)
      assert.strictEqual(dp.bucketCounts.length, EXPLICIT_BOUNDS_SECONDS.length + 1)
      // 1s and 3s land in two distinct fixed buckets; counts sum to the total.
      assert.strictEqual(dp.bucketCounts.reduce((a, b) => a + b, 0), 2)
      assert.strictEqual(dp.bucketCounts.filter(c => c > 0).length, 2)
    })

    it('marks error data points with status.code=ERROR and ok data points without it', () => {
      const spans = [makeTopLevelSpan(), makeTopLevelSpan({ error: 1 })]
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, spans), BUCKET_SIZE_NS))
      const points = dataPointsOf(payload)

      const ok = points.find(dp => attrMapOf(dp)['dd.span.top_level'] === true && !attrMapOf(dp)['status.code'])
      const err = points.find(dp => attrMapOf(dp)['status.code'] === 2)
      assert.ok(ok, 'ok data point should carry no status.code')
      assert.strictEqual(attrMapOf(err)['dd.span.top_level'], true)
    })

    it('emits at most two data points per group (ok + error) tagged top-level when all hits are top-level', () => {
      // All spans share one aggregation key: okDistribution gets 2 ok, errorDistribution gets 1 error.
      const spans = [makeTopLevelSpan(), makeTopLevelSpan(), makeTopLevelSpan({ error: 1 })]
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, spans), BUCKET_SIZE_NS))
      const points = dataPointsOf(payload)

      assert.strictEqual(points.length, 2)
      const ok = points.find(dp => !attrMapOf(dp)['status.code'])
      const err = points.find(dp => attrMapOf(dp)['status.code'] === 2)
      assert.strictEqual(ok.count, 2)
      assert.strictEqual(err.count, 1)
      assert.strictEqual(attrMapOf(ok)['dd.span.top_level'], true)
      assert.strictEqual(attrMapOf(err)['dd.span.top_level'], true)
    })

    it('tags dd.span.top_level=false for a group mixing top-level and non-top-level hits', () => {
      const spans = [makeSpan(), makeTopLevelSpan()] // same aggregation key, mixed top-level
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, spans), BUCKET_SIZE_NS))
      const points = dataPointsOf(payload)

      assert.strictEqual(points.length, 1)
      assert.strictEqual(points[0].count, 2)
      assert.strictEqual(attrMapOf(points[0])['dd.span.top_level'], false)
    })

    it('omits data points with zero count', () => {
      const payload = JSON.parse(
        transformer.transform(makeDrained(12340000000000, [makeTopLevelSpan({ error: 1 })]), BUCKET_SIZE_NS)
      )
      assert.strictEqual(dataPointsOf(payload).length, 1)
    })

    it('reports service identity on the dd-trace scope, not the resource', () => {
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, [makeSpan()]), BUCKET_SIZE_NS))
      const resourceAttrs = Object.fromEntries(
        payload.resourceMetrics[0].resource.attributes.map(a => [a.key, a.value.stringValue])
      )
      const scope = payload.resourceMetrics[0].scopeMetrics[0].scope
      const scopeAttrs = Object.fromEntries(scope.attributes.map(a => [a.key, a.value.stringValue]))

      assert.strictEqual(scope.name, 'dd-trace')
      assert.deepStrictEqual(scopeAttrs, {
        'service.name': 'svc',
        'service.version': '1.2.3',
        'deployment.environment.name': 'test',
      })
      assert.ok(!('service.name' in resourceAttrs), 'service.name should not be a resource attribute')
      assert.ok(!('deployment.environment.name' in resourceAttrs), 'env should not be a resource attribute')
    })

    it('partitions data points into one scope per service', () => {
      const drained = makeDrained(12340000000000, [
        makeSpan({ service: 'svc-a' }),
        makeSpan({ service: 'svc-b' }),
      ])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS))
      const scopes = payload.resourceMetrics[0].scopeMetrics
      const servicesByScope = scopes.map(sm =>
        sm.scope.attributes.find(a => a.key === 'service.name').value.stringValue
      )

      assert.strictEqual(scopes.length, 2)
      assert.deepStrictEqual(servicesByScope.sort(), ['svc-a', 'svc-b'])
      for (const sm of scopes) {
        assert.strictEqual(sm.metrics[0].histogram.dataPoints.length, 1)
      }
    })

    it('sets timestamps from the bucket time and size', () => {
      const timeNs = 12340000000000
      const dp = dataPointsOf(JSON.parse(transformer.transform(makeDrained(timeNs, [makeSpan()]), BUCKET_SIZE_NS)))[0]

      assert.deepStrictEqual(
        { start: dp.startTimeUnixNano, end: dp.timeUnixNano },
        { start: String(timeNs), end: String(timeNs + BUCKET_SIZE_NS) }
      )
    })

    it('handles multiple time buckets', () => {
      const drained = [
        { timeNs: 12340000000000, bucket: makeBucket([makeSpan()]) },
        { timeNs: 12350000000000, bucket: makeBucket([makeSpan()]) },
      ]
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS))
      assert.strictEqual(dataPointsOf(payload).length, 2)
    })
  })

  describe('JSON format (OTel-semantics mode)', () => {
    let transformer

    before(() => {
      transformer = new OtlpStatsTransformer(RESOURCE_ATTRS, 'http/json', true)
    })

    it('emits only OTel attributes (no dd.*) while keeping status.code on errors', () => {
      const span = makeTopLevelSpan({
        error: 1,
        meta: { [HTTP_STATUS_CODE]: 500, [HTTP_METHOD]: 'GET', [ORIGIN_KEY]: 'synthetics' },
      })
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, [span]), BUCKET_SIZE_NS))
      const attrs = attrMapOf(dataPointsOf(payload)[0])

      assert.ok(!Object.keys(attrs).some(k => k.startsWith('dd.')), 'no dd.* attributes in OTel-semantics mode')
      assert.deepStrictEqual(
        { name: attrs['span.name'], method: attrs['http.request.method'], status: attrs['status.code'] },
        { name: 'GET /foo', method: 'GET', status: 2 }
      )
    })
  })

  describe('protobuf format', () => {
    let transformer

    before(() => {
      transformer = new OtlpStatsTransformer(RESOURCE_ATTRS, 'http/protobuf')
    })

    it('emits a valid ExportMetricsServiceRequest with a single duration metric', () => {
      const buf = transformer.transform(makeDrained(12340000000000, [makeSpan()]), BUCKET_SIZE_NS)
      assert.ok(Buffer.isBuffer(buf))

      const metrics = protoMetricsService.decode(buf).resourceMetrics[0].scopeMetrics[0].metrics
      assert.strictEqual(metrics.length, 1)
      assert.strictEqual(metrics[0].name, METRIC_NAME)
    })

    it('uses delta temporality and native typed attribute values', () => {
      const delta = protoAggregationTemporality.values.AGGREGATION_TEMPORALITY_DELTA
      // Distinct aggregation keys so the per-group top-level heuristic yields one ok-not-top-level
      // group and one error-top-level group.
      const spans = [makeSpan({ resource: 'GET /a' }), makeTopLevelSpan({ error: 1, resource: 'GET /b' })]
      const buf = transformer.transform(makeDrained(12340000000000, spans), BUCKET_SIZE_NS)
      const decoded = protoMetricsService.decode(buf)
      const metric = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]

      assert.strictEqual(metric.histogram.aggregationTemporality, delta)
      const okNotTopLevel = metric.histogram.dataPoints.find(dp =>
        dp.attributes.some(a => a.key === 'dd.span.top_level' && a.value.boolValue === false) &&
        !dp.attributes.some(a => a.key === 'status.code')
      )
      const errTopLevel = metric.histogram.dataPoints.find(dp =>
        dp.attributes.some(a => a.key === 'status.code' && Number(a.value.intValue) === 2) &&
        dp.attributes.some(a => a.key === 'dd.span.top_level' && a.value.boolValue === true)
      )
      assert.ok(okNotTopLevel, 'should have ok not-top-level data point')
      assert.ok(errTopLevel, 'should have error top-level data point')
    })
  })
})
