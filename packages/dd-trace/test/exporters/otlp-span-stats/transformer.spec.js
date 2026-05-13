'use strict'

const assert = require('node:assert/strict')
const { describe, it, before } = require('mocha')

require('../../setup/core')

const OtlpStatsTransformer = require('../../../src/exporters/otlp-span-stats/transformer')
const { SpanBuckets } = require('../../../src/span_stats')
const { getProtobufTypes } = require('../../../src/opentelemetry/otlp/protobuf_loader')
const { HTTP_STATUS_CODE, HTTP_METHOD, HTTP_ROUTE } = require('../../../../../ext/tags')
const { ORIGIN_KEY } = require('../../../src/constants')
const { TOP_LEVEL_KEY } = require('../../../src/constants')

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

    it('emits a single dd.trace.span.duration metric', () => {
      const span = makeSpan()
      const drained = makeDrained(12340000000000, [span])

      const buf = transformer.transform(drained, BUCKET_SIZE_NS)
      const payload = JSON.parse(buf.toString())

      const { metrics } = payload.resourceMetrics[0].scopeMetrics[0]
      assert.strictEqual(metrics.length, 1)
      assert.strictEqual(metrics[0].name, 'dd.trace.span.duration')
    })

    it('emits correct unit and temporality', () => {
      const drained = makeDrained(12340000000000, [makeSpan()])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const metric = payload.resourceMetrics[0].scopeMetrics[0].metrics[0]

      assert.strictEqual(metric.unit, 's')
      assert.strictEqual(metric.histogram.aggregationTemporality, 'AGGREGATION_TEMPORALITY_DELTA')
    })

    it('maps span attributes correctly using new dimension mapping', () => {
      const span = makeSpan({
        meta: {
          [HTTP_STATUS_CODE]: 404,
          [HTTP_METHOD]: 'POST',
          [HTTP_ROUTE]: '/users/:id',
        },
      })
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0]

      const attrMap = Object.fromEntries(dp.attributes.map(a => [a.key, a.value.stringValue]))
      // resource → span.name; name → dd.operation.name
      assert.strictEqual(attrMap['span.name'], 'GET /foo')
      assert.strictEqual(attrMap['dd.operation.name'], 'test.op')
      assert.strictEqual(attrMap['dd.span.type'], 'web')
      assert.strictEqual(attrMap['http.response.status_code'], '404')
      assert.strictEqual(attrMap['http.request.method'], 'POST')
      assert.strictEqual(attrMap['http.route'], '/users/:id')
    })

    it('omits http attributes when not present', () => {
      const span = makeSpan({ meta: {} })
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0]

      const keys = dp.attributes.map(a => a.key)
      assert.ok(!keys.includes('http.response.status_code'))
      assert.ok(!keys.includes('http.request.method'))
      assert.ok(!keys.includes('http.route'))
    })

    it('converts duration from ns to seconds', () => {
      const span = makeSpan({ duration: 2e9 }) // 2 seconds
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0]

      assert.strictEqual(dp.sum, 2)
    })

    it('emits ok-not-top-level data point with dd.top_level=false, no error attr', () => {
      const span = makeSpan() // not top-level, no error
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { dataPoints } = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram

      assert.strictEqual(dataPoints.length, 1)
      const dp = dataPoints[0]
      const attrMap = Object.fromEntries(dp.attributes.map(a => [a.key, a.value.stringValue ?? a.value.boolValue]))
      assert.strictEqual(attrMap['dd.top_level'], 'false')
      assert.ok(!Object.prototype.hasOwnProperty.call(attrMap, 'error'), 'error attr should not be present on ok spans')
      assert.strictEqual(dp.count, 1)
    })

    it('emits ok-top-level data point with dd.top_level=true, no error attr', () => {
      const span = makeTopLevelSpan()
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { dataPoints } = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram

      assert.strictEqual(dataPoints.length, 1)
      const dp = dataPoints[0]
      const attrMap = Object.fromEntries(dp.attributes.map(a => [a.key, a.value.stringValue ?? a.value.boolValue]))
      assert.strictEqual(attrMap['dd.top_level'], 'true')
      assert.ok(!Object.prototype.hasOwnProperty.call(attrMap, 'error'))
      assert.strictEqual(dp.count, 1)
    })

    it('emits error-not-top-level data point with error=true and dd.top_level=false', () => {
      const span = makeSpan({ error: 1 }) // not top-level, error
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { dataPoints } = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram

      assert.strictEqual(dataPoints.length, 1)
      const dp = dataPoints[0]
      const attrMap = Object.fromEntries(dp.attributes.map(a => [a.key, a.value.stringValue ?? a.value.boolValue]))
      assert.strictEqual(attrMap['error'], 'true')
      assert.strictEqual(attrMap['dd.top_level'], 'false')
      assert.strictEqual(dp.count, 1)
    })

    it('emits error-top-level data point with error=true and dd.top_level=true', () => {
      const span = makeTopLevelSpan({ error: 1 })
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { dataPoints } = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram

      assert.strictEqual(dataPoints.length, 1)
      const dp = dataPoints[0]
      const attrMap = Object.fromEntries(dp.attributes.map(a => [a.key, a.value.stringValue ?? a.value.boolValue]))
      assert.strictEqual(attrMap['error'], 'true')
      assert.strictEqual(attrMap['dd.top_level'], 'true')
      assert.strictEqual(dp.count, 1)
    })

    it('emits all 4 data points for spans across all 4 cells', () => {
      const spans = [
        makeSpan(),                               // ok, not top-level
        makeTopLevelSpan(),                       // ok, top-level
        makeSpan({ error: 1 }),                   // error, not top-level
        makeTopLevelSpan({ error: 1 }),            // error, top-level
      ]
      const drained = makeDrained(12340000000000, spans)
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { dataPoints } = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram

      assert.strictEqual(dataPoints.length, 4)
    })

    it('records correct counts per cell', () => {
      const spans = [
        makeSpan(), makeSpan(),                            // 2 ok not-top-level
        makeTopLevelSpan(), makeTopLevelSpan(),            // 2 ok top-level (same aggKey)
        makeSpan({ error: 1 }),                           // 1 error not-top-level
        makeTopLevelSpan({ error: 1 }),                   // 1 error top-level
      ]
      const drained = makeDrained(12340000000000, spans)
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { dataPoints } = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram

      const getCount = (errorVal, topLevelVal) => {
        const dp = dataPoints.find(d => {
          const attrMap = Object.fromEntries(d.attributes.map(a => [a.key, a.value.stringValue]))
          if (errorVal === undefined) {
            return !attrMap.error && attrMap['dd.top_level'] === String(topLevelVal)
          }
          return attrMap.error === String(errorVal) && attrMap['dd.top_level'] === String(topLevelVal)
        })
        return dp?.count ?? 0
      }

      assert.strictEqual(getCount(undefined, false), 2)  // ok, not top-level
      assert.strictEqual(getCount(undefined, true), 2)   // ok, top-level
      assert.strictEqual(getCount(true, false), 1)       // error, not top-level
      assert.strictEqual(getCount(true, true), 1)        // error, top-level
    })

    it('omits data points with zero count', () => {
      const span = makeTopLevelSpan({ error: 1 }) // only error top-level
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const { dataPoints } = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram

      assert.strictEqual(dataPoints.length, 1)
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
      const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0]

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
      const { dataPoints } = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram

      assert.strictEqual(dataPoints.length, 2)
    })

    it('records synthetics attribute', () => {
      const span = makeSpan({ meta: { [HTTP_STATUS_CODE]: 200, [ORIGIN_KEY]: 'synthetics' } })
      const drained = makeDrained(12340000000000, [span])
      const payload = JSON.parse(transformer.transform(drained, BUCKET_SIZE_NS).toString())
      const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0]

      const attrMap = Object.fromEntries(dp.attributes.map(a => [a.key, a.value.stringValue]))
      assert.strictEqual(attrMap['dd.synthetics'], 'true')
    })
  })

  describe('protobuf format', () => {
    let transformer

    before(() => {
      transformer = new OtlpStatsTransformer(RESOURCE_ATTRS, 'http/protobuf')
    })

    it('emits a valid ExportMetricsServiceRequest with single duration metric', () => {
      const span = makeSpan()
      const drained = makeDrained(12340000000000, [span])

      const buf = transformer.transform(drained, BUCKET_SIZE_NS)
      assert.ok(Buffer.isBuffer(buf))

      const decoded = protoMetricsService.decode(buf)
      const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics
      assert.strictEqual(metrics.length, 1)
      assert.strictEqual(metrics[0].name, 'dd.trace.span.duration')
    })

    it('uses AGGREGATION_TEMPORALITY_DELTA', () => {
      const delta = protoAggregationTemporality.values.AGGREGATION_TEMPORALITY_DELTA
      const drained = makeDrained(12340000000000, [makeSpan()])

      const buf = transformer.transform(drained, BUCKET_SIZE_NS)
      const decoded = protoMetricsService.decode(buf)
      const metric = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0]

      assert.strictEqual(metric.histogram.aggregationTemporality, delta)
    })

    it('uses boolValue for error and dd.top_level attributes in protobuf', () => {
      const spans = [makeSpan(), makeTopLevelSpan({ error: 1 })]
      const drained = makeDrained(12340000000000, spans)

      const buf = transformer.transform(drained, BUCKET_SIZE_NS)
      const decoded = protoMetricsService.decode(buf)
      const { dataPoints } = decoded.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram

      const okNotTopLevel = dataPoints.find(dp =>
        dp.attributes.some(a => a.key === 'dd.top_level' && a.value.boolValue === false) &&
        !dp.attributes.some(a => a.key === 'error')
      )
      const errTopLevel = dataPoints.find(dp =>
        dp.attributes.some(a => a.key === 'error' && a.value.boolValue === true) &&
        dp.attributes.some(a => a.key === 'dd.top_level' && a.value.boolValue === true)
      )
      assert.ok(okNotTopLevel, 'should have ok not-top-level data point')
      assert.ok(errTopLevel, 'should have error top-level data point')
    })
  })
})
