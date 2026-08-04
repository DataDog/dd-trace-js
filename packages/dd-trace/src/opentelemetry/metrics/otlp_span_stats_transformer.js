'use strict'

const { LogCollapsingLowestDenseDDSketch } = require('../../../../../vendor/dist/@datadog/sketches-js')
const OtlpTransformerBase = require('../otlp/otlp_transformer_base')
const { getProtobufTypes } = require('../otlp/protobuf_loader')
const { GRPC_STATUS_NAMES } = require('../../constants')

const NS_PER_S = 1e9

// Must match libdatadog's EXPLICIT_BOUNDS_SECONDS and OTel spanmetrics connector defaults.
const EXPLICIT_BOUNDS_SECONDS = [
  0.002, 0.004, 0.006, 0.008, 0.01, 0.05, 0.1, 0.2, 0.4, 0.8, 1, 1.4, 2, 5, 10, 15,
]

const SPAN_KIND_METRIC_MAP = {
  internal: 'SPAN_KIND_INTERNAL',
  server: 'SPAN_KIND_SERVER',
  client: 'SPAN_KIND_CLIENT',
  producer: 'SPAN_KIND_PRODUCER',
  consumer: 'SPAN_KIND_CONSUMER',
}

/**
 * @param {object} sketch
 * @returns {number[]}
 */
function sketchToFixedHistogram (sketch) {
  const bucketCounts = new Array(EXPLICIT_BOUNDS_SECONDS.length + 1).fill(0)
  if (sketch.zeroCount > 0) bucketCounts[0] += sketch.zeroCount
  const { store, mapping } = sketch
  for (let key = store.minKey; key <= store.maxKey; key++) {
    const weight = store.bins[key - store.offset]
    if (!weight) continue
    const seconds = mapping.value(key) / NS_PER_S
    let idx = EXPLICIT_BOUNDS_SECONDS.findIndex((bound) => seconds <= bound)
    if (idx === -1) idx = EXPLICIT_BOUNDS_SECONDS.length
    bucketCounts[idx] += weight
  }
  return bucketCounts.map((weight) => Math.round(weight))
}

let _deltaTemporality

function getDeltaTemporality () {
  if (_deltaTemporality === undefined) {
    const { protoAggregationTemporality } = getProtobufTypes()
    _deltaTemporality = protoAggregationTemporality.values.AGGREGATION_TEMPORALITY_DELTA
  }
  return _deltaTemporality
}

const STATUS_CODE_OK_ATTR = { key: 'status.code', value: { stringValue: 'STATUS_CODE_OK' } }
const STATUS_CODE_ERROR_ATTR = { key: 'status.code', value: { stringValue: 'STATUS_CODE_ERROR' } }

class OtlpStatsTransformer extends OtlpTransformerBase {
  #otelSemanticsEnabled

  /**
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes
   * @param {string} protocol
   * @param {boolean} [otelSemanticsEnabled]
   */
  constructor (resourceAttributes, protocol, otelSemanticsEnabled = false) {
    super(resourceAttributes, protocol, 'span-stats')
    this.#otelSemanticsEnabled = otelSemanticsEnabled
  }

  /**
   * @param {Array<{timeNs: number, bucket: import('../../span_stats').SpanBuckets}>} drained
   * @param {number} bucketSizeNs
   */
  transform (drained, bucketSizeNs) {
    const isJson = this.protocol === 'http/json'
    const data = {
      resourceMetrics: [{
        resource: this.transformResource(),
        scopeMetrics: this.#buildScopeMetrics(drained, bucketSizeNs, isJson),
      }],
    }
    return isJson
      ? this.serializeToJson(data)
      : this.serializeToProtobuf(getProtobufTypes().protoMetricsService, data)
  }

  #buildScopeMetrics (drained, bucketSizeNs, isJson) {
    const temporality = isJson ? 'AGGREGATION_TEMPORALITY_DELTA' : getDeltaTemporality()

    const dataPoints = []

    for (const { timeNs, bucket } of drained) {
      const endTimeNs = timeNs + bucketSizeNs
      const startNano = isJson ? String(timeNs) : timeNs
      const endNano = isJson ? String(endTimeNs) : endTimeNs

      for (const aggStats of bucket.values()) {
        const baseAttrs = this.#buildAttributes(aggStats.aggKey)

        if (this.#otelSemanticsEnabled) {
          const okDist = new LogCollapsingLowestDenseDDSketch()
          okDist.merge(aggStats.topLevelOkDistribution)
          okDist.merge(aggStats.nonTopLevelOkDistribution)
          const errDist = new LogCollapsingLowestDenseDDSketch()
          errDist.merge(aggStats.topLevelErrorDistribution)
          errDist.merge(aggStats.nonTopLevelErrorDistribution)
          this.#pushPoint(dataPoints, okDist, startNano, endNano, [...baseAttrs, STATUS_CODE_OK_ATTR])
          this.#pushPoint(dataPoints, errDist, startNano, endNano, [...baseAttrs, STATUS_CODE_ERROR_ATTR])
        } else {
          const tlAttrs = [...baseAttrs, { key: 'datadog.span.top_level', value: { boolValue: true } }]
          const ntlAttrs = [...baseAttrs, { key: 'datadog.span.top_level', value: { boolValue: false } }]
          this.#pushPoint(dataPoints, aggStats.topLevelOkDistribution, startNano, endNano,
            [...tlAttrs, STATUS_CODE_OK_ATTR])
          this.#pushPoint(dataPoints, aggStats.topLevelErrorDistribution, startNano, endNano,
            [...tlAttrs, STATUS_CODE_ERROR_ATTR])
          this.#pushPoint(dataPoints, aggStats.nonTopLevelOkDistribution, startNano, endNano,
            [...ntlAttrs, STATUS_CODE_OK_ATTR])
          this.#pushPoint(dataPoints, aggStats.nonTopLevelErrorDistribution, startNano, endNano,
            [...ntlAttrs, STATUS_CODE_ERROR_ATTR])
        }
      }
    }

    if (dataPoints.length === 0) return []
    return [{
      metrics: [
        {
          name: 'traces.span.sdk.metrics.duration',
          unit: 's',
          histogram: { dataPoints, aggregationTemporality: temporality },
        },
      ],
    }]
  }

  #pushPoint (points, sketch, startNano, endNano, attributes) {
    if (!sketch || sketch.count === 0) return
    points.push({
      attributes,
      startTimeUnixNano: startNano,
      timeUnixNano: endNano,
      count: sketch.count,
      sum: sketch.sum / NS_PER_S,
      min: sketch.min / NS_PER_S,
      max: sketch.max / NS_PER_S,
      bucketCounts: sketchToFixedHistogram(sketch),
      explicitBounds: EXPLICIT_BOUNDS_SECONDS,
    })
  }

  /**
   * @param {import('../../span_stats').SpanAggKey} aggKey
   */
  #buildAttributes (aggKey) {
    const raw = { 'span.name': aggKey.resource, 'service.name': aggKey.service }

    if (aggKey.spanKind) raw['span.kind'] = SPAN_KIND_METRIC_MAP[aggKey.spanKind] ?? aggKey.spanKind
    if (aggKey.statusCode) raw['http.response.status_code'] = Number(aggKey.statusCode)
    if (aggKey.method) raw['http.request.method'] = aggKey.method
    if (aggKey.endpoint) raw['http.route'] = aggKey.endpoint
    if (aggKey.rpcStatusCode !== '') {
      const n = Number(aggKey.rpcStatusCode)
      raw['rpc.response.status_code'] = Number.isInteger(n) && n >= 0 && n < GRPC_STATUS_NAMES.length
        ? GRPC_STATUS_NAMES[n]
        : String(aggKey.rpcStatusCode).toUpperCase()
    }

    // TODO: additional_metric_tags support is still evolving/TBD across most SDKs; not implemented here yet.

    if (!this.#otelSemanticsEnabled) {
      raw['datadog.operation.name'] = aggKey.name
      if (aggKey.type) raw['datadog.span.type'] = aggKey.type
      if (aggKey.synthetics) raw['datadog.origin'] = 'synthetics'
      raw['datadog.is_trace_root'] = aggKey.isTraceRoot
    }

    return this.transformAttributes(raw)
  }
}

module.exports = OtlpStatsTransformer
module.exports.EXPLICIT_BOUNDS_SECONDS = EXPLICIT_BOUNDS_SECONDS
