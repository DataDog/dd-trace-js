'use strict'

const assert = require('node:assert/strict')
const { describe, it, before } = require('mocha')

require('../../setup/core')

const OtlpStatsTransformer = require('../../../src/exporters/otlp-span-stats/transformer')
const { SpanBuckets } = require('../../../src/span_stats')
const { getProtobufTypes } = require('../../../src/opentelemetry/otlp/protobuf_loader')
const { HTTP_STATUS_CODE, HTTP_METHOD, HTTP_ROUTE } = require('../../../../../ext/tags')
const { ORIGIN_KEY } = require('../../../src/constants')

const RESOURCE_ATTRS = { 'service.name': 'test-service', 'deployment.environment.name': 'test' }
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

    it('emits 4 metrics for a basic span', () => {
      const span = makeSpan()
      const timeNs = 12340000000000
      const drained = makeDrained(timeNs, [span])

      const buf = transformer.transform(drained, BUCKET_SIZE_NS)
      const payload = JSON.parse(buf.toString())

      const { metrics } = payload.resourceMetrics[0].scopeMetrics[0]
      assert.strictEqual(metrics.length, 4)
      assert.strictEqual(metrics[0].name, 'dd.trace.span.hits')
      assert.strictEqual(metrics[1].name, 'dd.trace.span.errors')
      assert.strictEqual(metrics[2].name, 'dd.trace.span.top_level_hits')
      assert.strictEqual(metrics[3].name, 'dd.trace.span.duration')
    })

    it('emits correct units and temporality', () => {
      const span = makeSpan()
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { metrics } = payload.resourceMetrics[0].scopeMetrics[0]

      assert.strictEqual(metrics[0].unit, '{span}')
      assert.strictEqual(metrics[3].unit, 's')

      assert.strictEqual(metrics[0].sum.aggregationTemporality, 'AGGREGATION_TEMPORALITY_DELTA')
      assert.strictEqual(metrics[0].sum.isMonotonic, true)
      assert.strictEqual(metrics[3].histogram.aggregationTemporality, 'AGGREGATION_TEMPORALITY_DELTA')
    })

    it('maps span attributes correctly', () => {
      const span = makeSpan({
        meta: {
          [HTTP_STATUS_CODE]: 404,
          [HTTP_METHOD]: 'POST',
          [HTTP_ROUTE]: '/users/:id',
        },
      })
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]

      const attrMap = Object.fromEntries(dp.attributes.map(a => [a.key, a.value.stringValue]))
      assert.strictEqual(attrMap['span.name'], 'test.op')
      assert.strictEqual(attrMap['dd.resource'], 'GET /foo')
      assert.strictEqual(attrMap['dd.span.type'], 'web')
      assert.strictEqual(attrMap['http.response.status_code'], '404')
      assert.strictEqual(attrMap['http.request.method'], 'POST')
      assert.strictEqual(attrMap['http.route'], '/users/:id')
    })

    it('omits http attributes when not present', () => {
      const span = makeSpan({ meta: {} })
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]

      const keys = dp.attributes.map(a => a.key)
      assert.ok(!keys.includes('http.response.status_code'))
      assert.ok(!keys.includes('http.request.method'))
      assert.ok(!keys.includes('http.route'))
    })

    it('records hits count correctly', () => {
      const spans = [makeSpan(), makeSpan(), makeSpan()]
      const drained = makeDrained(12340000000000, spans)
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]

      assert.strictEqual(dp.asInt, 3)
    })

    it('records error count correctly', () => {
      const spans = [makeSpan({ error: 1 }), makeSpan({ error: 1 }), makeSpan()]
      const drained = makeDrained(12340000000000, spans)
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const errorDp = payload.resourceMetrics[0].scopeMetrics[0].metrics[1].sum.dataPoints[0]

      assert.strictEqual(errorDp.asInt, 2)
    })

    it('emits duration histogram split by error=true/false', () => {
      const spans = [makeSpan(), makeSpan({ error: 1 })]
      const drained = makeDrained(12340000000000, spans)
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { dataPoints } = payload.resourceMetrics[0].scopeMetrics[0].metrics[3].histogram

      assert.strictEqual(dataPoints.length, 2)
      const okDp = dataPoints.find(dp => dp.attributes.some(a => a.key === 'error' && a.value.stringValue === 'false'))
      const errDp = dataPoints.find(dp => dp.attributes.some(a => a.key === 'error' && a.value.stringValue === 'true'))

      assert.ok(okDp, 'should have ok data point')
      assert.ok(errDp, 'should have error data point')
      assert.strictEqual(okDp.count, 1)
      assert.strictEqual(errDp.count, 1)
    })

    it('converts duration from ns to seconds', () => {
      const span = makeSpan({ duration: 2e9 }) // 2 seconds
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[3].histogram.dataPoints[0]

      assert.strictEqual(dp.sum, 2)
    })

    it('omits ok duration data point when all spans are errors', () => {
      const span = makeSpan({ error: 1 })
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { dataPoints } = payload.resourceMetrics[0].scopeMetrics[0].metrics[3].histogram

      assert.strictEqual(dataPoints.length, 1)
      assert.ok(dataPoints[0].attributes.some(a => a.key === 'error' && a.value.stringValue === 'true'))
    })

    it('omits error duration data point when no errors', () => {
      const span = makeSpan()
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { dataPoints } = payload.resourceMetrics[0].scopeMetrics[0].metrics[3].histogram

      assert.strictEqual(dataPoints.length, 1)
      assert.ok(dataPoints[0].attributes.some(a => a.key === 'error' && a.value.stringValue === 'false'))
    })

    it('includes resource attributes', () => {
      const drained = makeDrained(12340000000000, [makeSpan()])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { attributes } = payload.resourceMetrics[0].resource

      const attrMap = Object.fromEntries(attributes.map(a => [a.key, a.value.stringValue]))
      assert.strictEqual(attrMap['service.name'], 'test-service')
      assert.strictEqual(attrMap['deployment.environment.name'], 'test')
    })

    it('uses scope name dd-trace', () => {
      const drained = makeDrained(12340000000000, [makeSpan()])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { scope } = payload.resourceMetrics[0].scopeMetrics[0]

      assert.strictEqual(scope.name, 'dd-trace')
    })

    it('sets timestamps from bucket timeNs', () => {
      const timeNs = 12340000000000
      const drained = makeDrained(timeNs, [makeSpan()])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]

      assert.strictEqual(dp.startTimeUnixNano, String(timeNs))
      assert.strictEqual(dp.timeUnixNano, String(timeNs + BUCKET_SIZE_NS))
    })

    it('handles multiple time buckets', () => {
      const bucket1 = makeBucket([makeSpan()])
      const bucket2 = makeBucket([makeSpan()])
      const drained = [
        { timeNs: 12340000000000, bucket: bucket1 },
        { timeNs: 12350000000000, bucket: bucket2 },
      ]
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { dataPoints } = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum

      assert.strictEqual(dataPoints.length, 2)
    })

    it('records synthetics attribute', () => {
      const span = makeSpan({ meta: { [HTTP_STATUS_CODE]: 200, [ORIGIN_KEY]: 'synthetics' } })
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]

      const attrMap = Object.fromEntries(dp.attributes.map(a => [a.key, a.value.stringValue]))
      assert.strictEqual(attrMap['dd.synthetics'], 'true')
    })
  })

  describe('protobuf format', () => {
    let transformer

    before(() => {
      transformer = new OtlpStatsTransformer(RESOURCE_ATTRS, 'http/protobuf')
    })

    it('emits a valid ExportMetricsServiceRequest', () => {
      const span = makeSpan()
      const drained = makeDrained(12340000000000, [span])

      const buf = transformer.transform(drained, BUCKET_SIZE_NS)
      assert.ok(Buffer.isBuffer(buf))

      const decoded = protoMetricsService.decode(buf)
      const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
      assert.strictEqual(metrics.length, 4)
      assert.strictEqual(metrics[0].name, 'dd.trace.span.hits')
      assert.strictEqual(metrics[3].name, 'dd.trace.span.duration')
    })

    it('uses AGGREGATION_TEMPORALITY_DELTA for all metrics', () => {
      const delta = protoAggregationTemporality.values.AGGREGATION_TEMPORALITY_DELTA
      const span = makeSpan()
      const drained = makeDrained(12340000000000, [span])

      const buf = transformer.transform(drained, BUCKET_SIZE_NS)
      const decoded = protoMetricsService.decode(buf)
      const { metrics } = decoded.resourceMetrics[0].scopeMetrics[0]

      assert.strictEqual(metrics[0].sum.aggregationTemporality, delta)
      assert.strictEqual(metrics[3].histogram.aggregationTemporality, delta)
    })

    it('uses boolValue for error attribute in protobuf', () => {
      const spans = [makeSpan(), makeSpan({ error: 1 })]
      const drained = makeDrained(12340000000000, spans)

      const buf = transformer.transform(drained, BUCKET_SIZE_NS)
      const decoded = protoMetricsService.decode(buf)
      const { dataPoints } = decoded.resourceMetrics[0].scopeMetrics[0].metrics[3].histogram

      const okDp = dataPoints.find(dp => dp.attributes.some(a => a.key === 'error' && a.value.boolValue === false))
      const errDp = dataPoints.find(dp => dp.attributes.some(a => a.key === 'error' && a.value.boolValue === true))
      assert.ok(okDp)
      assert.ok(errDp)
    })
  })
})
