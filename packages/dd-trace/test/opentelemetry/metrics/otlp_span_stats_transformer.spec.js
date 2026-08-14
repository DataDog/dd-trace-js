'use strict'

const assert = require('node:assert/strict')
const { describe, it, before } = require('mocha')

require('../../setup/core')

const OtlpStatsTransformer = require('../../../src/opentelemetry/metrics/otlp_span_stats_transformer')
const { EXPLICIT_BOUNDS_SECONDS } = OtlpStatsTransformer
const { SpanBuckets } = require('../../../src/span_stats')
const { getProtobufTypes } = require('../../../src/opentelemetry/otlp/protobuf_loader')
const { HTTP_STATUS_CODE, HTTP_METHOD, HTTP_ROUTE, SPAN_KIND, GRPC_STATUS_CODE } = require('../../../../../ext/tags')
const { ORIGIN_KEY, TOP_LEVEL_KEY, SVC_SRC_KEY } = require('../../../src/constants')

const METRIC_NAME = 'traces.span.sdk.metrics.duration'
const RESOURCE_ATTRS = {
  'telemetry.sdk.name': 'datadog',
  'telemetry.sdk.language': 'nodejs',
  'service.name': 'svc',
  'service.version': '1.2.3',
  'deployment.environment.name': 'test',
}
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

function makeBucket (spans, includeTraceRoot) {
  const bucket = new SpanBuckets(includeTraceRoot)
  for (const span of spans) {
    bucket.forSpan(span).record(span)
  }
  return bucket
}

function makeDrained (timeNs, spans, includeTraceRoot) {
  return [{ timeNs, bucket: makeBucket(spans, includeTraceRoot) }]
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

  describe('JSON format', () => {
    let transformer

    before(() => {
      transformer = new OtlpStatsTransformer(RESOURCE_ATTRS, 'http/json')
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
        parent_id: { equals: () => true },
        meta: {
          [HTTP_STATUS_CODE]: 404,
          [HTTP_METHOD]: 'POST',
          [HTTP_ROUTE]: '/users/:id',
          [SPAN_KIND]: 'server',
          [GRPC_STATUS_CODE]: 'OK',
          [ORIGIN_KEY]: 'synthetics',
          [SVC_SRC_KEY]: 'integration',
        },
      })
      const payload = JSON.parse(transformer.transform(
        makeDrained(12340000000000, [span], true),
        BUCKET_SIZE_NS
      ))
      const dataPoint = dataPointsOf(payload)[0]

      assert.deepStrictEqual(attrMapOf(dataPoint), {
        'span.name': 'GET /foo',
        'service.name': 'svc',
        'span.kind': 'SPAN_KIND_SERVER',
        'http.response.status_code': 404,
        'http.request.method': 'POST',
        'http.route': '/users/:id',
        'rpc.response.status_code': 'OK',
        'status.code': 'STATUS_CODE_OK',
        'datadog.operation.name': 'test.op',
        'datadog.span.type': 'web',
        'datadog.origin': 'synthetics',
        'datadog.svc_src': 'integration',
        'datadog.span.top_level': false,
        'datadog.is_trace_root': true,
      })
      assert.deepStrictEqual(
        dataPoint.attributes.filter(({ key }) => key === 'datadog.span.top_level' || key === 'datadog.is_trace_root'),
        [
          { key: 'datadog.is_trace_root', value: { boolValue: true } },
          { key: 'datadog.span.top_level', value: { boolValue: false } },
        ]
      )
    })

    it('coalesces span.kind aliases that map to the same exported attribute', () => {
      const spans = [
        makeSpan({ meta: { [SPAN_KIND]: 'server' } }),
        makeSpan({ meta: { [SPAN_KIND]: 'SPAN_KIND_SERVER' } }),
      ]
      const drained = makeDrained(12340000000000, spans)
      assert.strictEqual(drained[0].bucket.size, 2)

      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS))
      const points = dataPointsOf(payload)

      assert.strictEqual(points.length, 1)
      assert.strictEqual(points[0].count, 2)
      assert.strictEqual(attrMapOf(points[0])['span.kind'], 'SPAN_KIND_SERVER')
    })

    it('defaults missing and unknown span.kind values to SPAN_KIND_INTERNAL', () => {
      const spans = [
        makeSpan(),
        makeSpan({ meta: { [HTTP_STATUS_CODE]: 200, [SPAN_KIND]: 'unknown' } }),
        makeSpan({ meta: { [HTTP_STATUS_CODE]: 200, [SPAN_KIND]: 'SPAN_KIND_UNSPECIFIED' } }),
        makeSpan({ meta: { [HTTP_STATUS_CODE]: 200, [SPAN_KIND]: 'toString' } }),
        makeSpan({ meta: { [HTTP_STATUS_CODE]: 200, [SPAN_KIND]: 'constructor' } }),
      ]
      const drained = makeDrained(12340000000000, spans)
      assert.strictEqual(drained[0].bucket.size, 5)

      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS))
      const points = dataPointsOf(payload)

      assert.strictEqual(points.length, 1)
      assert.strictEqual(points[0].count, 5)
      assert.strictEqual(attrMapOf(points[0])['span.kind'], 'SPAN_KIND_INTERNAL')
    })

    it('keeps root and non-root distributions separate when datadog.is_trace_root is exported', () => {
      const spans = [
        makeSpan({ parent_id: { equals: () => true } }),
        makeSpan({ parent_id: { equals: () => false } }),
      ]
      const payload = JSON.parse(transformer.transform(
        makeDrained(12340000000000, spans, true),
        BUCKET_SIZE_NS
      ))
      const points = dataPointsOf(payload)

      assert.strictEqual(points.length, 2)
      assert.deepStrictEqual(points.map(point =>
        point.attributes.find(({ key }) => key === 'datadog.is_trace_root').value
      ), [{ boolValue: true }, { boolValue: false }])
    })

    it('omits datadog.is_trace_root when its value is unknown', () => {
      const drained = makeDrained(12340000000000, [makeSpan()], true)

      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS))

      assert.ok(!dataPointsOf(payload)[0].attributes.some(({ key }) => key === 'datadog.is_trace_root'))
    })

    it('omits datadog.svc_src when service source is empty', () => {
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, [makeSpan()]), BUCKET_SIZE_NS))

      assert.ok(!dataPointsOf(payload)[0].attributes.some(({ key }) => key === 'datadog.svc_src'))
    })

    it('emits the raw grpc.status.code name upper-cased as rpc.response.status_code', () => {
      const span = makeSpan({ meta: { [GRPC_STATUS_CODE]: 'not_found' }, metrics: {} })
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, [span]), BUCKET_SIZE_NS))

      assert.strictEqual(attrMapOf(dataPointsOf(payload)[0])['rpc.response.status_code'], 'NOT_FOUND')
    })

    it('translates numeric grpc.status.code from metrics to the canonical status name', () => {
      const span = makeSpan({ meta: {}, metrics: { [GRPC_STATUS_CODE]: 14 } })
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, [span]), BUCKET_SIZE_NS))

      assert.strictEqual(attrMapOf(dataPointsOf(payload)[0])['rpc.response.status_code'], 'UNAVAILABLE')
    })

    it('omits optional dimensions when not present on the span', () => {
      const payload = JSON.parse(
        transformer.transform(makeDrained(12340000000000, [makeSpan({ type: '', meta: {} })]), BUCKET_SIZE_NS)
      )
      const attrs = attrMapOf(dataPointsOf(payload)[0])

      for (const key of [
        'http.response.status_code',
        'http.request.method',
        'http.route',
        'datadog.span.type',
        'datadog.svc_src',
      ]) {
        assert.ok(!(key in attrs), `${key} should be omitted`)
      }
      assert.strictEqual(attrs['span.kind'], 'SPAN_KIND_INTERNAL')
    })

    it('converts duration to seconds with fixed bounds and a sketch-derived distribution', () => {
      const spans = [makeSpan({ duration: 1e9 }), makeSpan({ duration: 3e9 })]
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, spans), BUCKET_SIZE_NS))
      const dp = dataPointsOf(payload)[0]

      assert.strictEqual(dp.count, 2)
      assert.strictEqual(dp.min, 1)
      assert.strictEqual(dp.max, 3)
      assert.strictEqual(dp.sum, 4)
      assert.deepStrictEqual(dp.explicitBounds, EXPLICIT_BOUNDS_SECONDS)
      assert.strictEqual(dp.bucketCounts.length, EXPLICIT_BOUNDS_SECONDS.length + 1)
      assert.strictEqual(dp.bucketCounts.reduce((a, b) => a + b, 0), 2)
      assert.strictEqual(dp.bucketCounts.filter(c => c > 0).length, 2)
    })

    it('marks error data points with status.code=STATUS_CODE_ERROR and ok data points with STATUS_CODE_OK', () => {
      const spans = [makeTopLevelSpan(), makeTopLevelSpan({ error: 1 })]
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, spans), BUCKET_SIZE_NS))
      const points = dataPointsOf(payload)

      const ok = points.find(dp => attrMapOf(dp)['status.code'] === 'STATUS_CODE_OK')
      const err = points.find(dp => attrMapOf(dp)['status.code'] === 'STATUS_CODE_ERROR')
      assert.ok(ok, 'ok data point should carry status.code=STATUS_CODE_OK')
      assert.strictEqual(attrMapOf(err)['datadog.span.top_level'], true)
    })

    it('emits at most two data points per group (ok + error) tagged top-level when all hits are top-level', () => {
      const spans = [makeTopLevelSpan(), makeTopLevelSpan(), makeTopLevelSpan({ error: 1 })]
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, spans), BUCKET_SIZE_NS))
      const points = dataPointsOf(payload)

      assert.strictEqual(points.length, 2)
      const ok = points.find(dp => attrMapOf(dp)['status.code'] === 'STATUS_CODE_OK')
      const err = points.find(dp => attrMapOf(dp)['status.code'] === 'STATUS_CODE_ERROR')
      assert.strictEqual(ok.count, 2)
      assert.strictEqual(err.count, 1)
      assert.strictEqual(attrMapOf(ok)['datadog.span.top_level'], true)
      assert.strictEqual(attrMapOf(err)['datadog.span.top_level'], true)
    })

    it('emits separate data points for top-level and non-top-level spans sharing the same dimensions', () => {
      const spans = [makeSpan(), makeTopLevelSpan()]
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, spans), BUCKET_SIZE_NS))
      const points = dataPointsOf(payload)

      assert.strictEqual(points.length, 2)
      const topLevelPoint = points.find(dp => attrMapOf(dp)['datadog.span.top_level'] === true)
      const nonTopLevelPoint = points.find(dp => attrMapOf(dp)['datadog.span.top_level'] === false)
      assert.ok(topLevelPoint, 'top-level data point should exist')
      assert.ok(nonTopLevelPoint, 'non-top-level data point should exist')
      assert.strictEqual(topLevelPoint.count, 1)
      assert.strictEqual(nonTopLevelPoint.count, 1)
    })

    it('omits data points with zero count', () => {
      const payload = JSON.parse(
        transformer.transform(makeDrained(12340000000000, [makeTopLevelSpan({ error: 1 })]), BUCKET_SIZE_NS)
      )
      assert.strictEqual(dataPointsOf(payload).length, 1)
    })

    it('reports service identity on the resource and emits no InstrumentationScope', () => {
      const payload = JSON.parse(transformer.transform(makeDrained(12340000000000, [makeSpan()]), BUCKET_SIZE_NS))
      const resourceAttrs = Object.fromEntries(
        payload.resourceMetrics[0].resource.attributes.map(a => [a.key, a.value.stringValue])
      )
      const scopeMetrics = payload.resourceMetrics[0].scopeMetrics[0]

      assert.ok(!('scope' in scopeMetrics), 'no InstrumentationScope should be emitted')
      assert.strictEqual(resourceAttrs['service.name'], 'svc')
      assert.strictEqual(resourceAttrs['service.version'], '1.2.3')
      assert.strictEqual(resourceAttrs['deployment.environment.name'], 'test')
    })

    it('emits a single scopeMetrics and tags every data point with service.name, including the default service', () => {
      const drained = makeDrained(12340000000000, [
        makeSpan({ service: 'svc', resource: 'GET /foo' }),
        makeSpan({ service: 'svc-other', resource: 'GET /bar' }),
      ])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS))
      const scopeMetrics = payload.resourceMetrics[0].scopeMetrics

      assert.strictEqual(scopeMetrics.length, 1)
      assert.ok(!('scope' in scopeMetrics[0]), 'no InstrumentationScope should be emitted')
      const serviceByResource = Object.fromEntries(
        dataPointsOf(payload).map(dp => [attrMapOf(dp)['span.name'], attrMapOf(dp)['service.name']])
      )
      assert.strictEqual(serviceByResource['GET /foo'], 'svc')
      assert.strictEqual(serviceByResource['GET /bar'], 'svc-other')
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
      const spans = [
        makeSpan({ resource: 'GET /a' }),
        makeTopLevelSpan({ error: 1, resource: 'GET /b', meta: { [SVC_SRC_KEY]: 'integration' } }),
      ]
      const buf = transformer.transform(makeDrained(12340000000000, spans), BUCKET_SIZE_NS)
      const decoded = protoMetricsService.decode(buf)
      const metric = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]

      assert.strictEqual(metric.histogram.aggregationTemporality, delta)
      const okNotTopLevel = metric.histogram.dataPoints.find(dp =>
        dp.attributes.some(a => a.key === 'datadog.span.top_level' && a.value.boolValue === false) &&
        dp.attributes.some(a => a.key === 'status.code' && a.value.stringValue === 'STATUS_CODE_OK')
      )
      const errTopLevel = metric.histogram.dataPoints.find(dp =>
        dp.attributes.some(a => a.key === 'status.code' && a.value.stringValue === 'STATUS_CODE_ERROR') &&
        dp.attributes.some(a => a.key === 'datadog.span.top_level' && a.value.boolValue === true)
      )
      assert.ok(okNotTopLevel, 'should have ok not-top-level data point')
      assert.ok(errTopLevel, 'should have error top-level data point')
      assert.ok(errTopLevel.attributes.some(a =>
        a.key === 'datadog.svc_src' && a.value.stringValue === 'integration'
      ), 'service source should be an OTLP string')
    })
  })
})
