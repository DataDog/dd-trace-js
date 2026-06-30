'use strict'

const OtlpTransformerBase = require('../otlp/otlp_transformer_base')
const { getProtobufTypes } = require('../otlp/protobuf_loader')

const NS_PER_S = 1e9

// Fixed explicit histogram bucket boundaries (seconds), mirroring the OpenTelemetry spanmetrics
// connector defaults so the exported histogram is comparable across tracers and backends. Kept in
// sync with libdatadog's EXPLICIT_BOUNDS_SECONDS.
const EXPLICIT_BOUNDS_SECONDS = [
  0.002, 0.004, 0.006, 0.008, 0.01, 0.05, 0.1, 0.2, 0.4, 0.8, 1, 1.4, 2, 5, 10, 15,
]

/**
 * Buckets a DDSketch's bins into the fixed explicit bounds (see EXPLICIT_BOUNDS_SECONDS). Each bin's
 * representative value (converted to seconds) is accumulated into the matching bucket; values above
 * the last bound land in the trailing overflow bucket and exact zeros in the first bucket.
 *
 * @param {object} sketch - A LogCollapsingLowestDenseDDSketch (positive durations only)
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

// OTel span status code denoting an error (StatusCode.ERROR == 2). Emitted on error data points so the
// backend can derive error counts from status.code; ok/unset data points carry no status.code.
const ERROR_STATUS_ATTR = { key: 'status.code', value: { intValue: 2 } }

/**
 * Transforms span stats bucket data into an OTLP ExportMetricsServiceRequest.
 *
 * Emits a single histogram metric (delta temporality):
 *   - traces.span.sdk.metrics.duration (Histogram)
 *
 * Each aggregation key emits up to 2 data points (ok and error), each a fixed explicit-bounds
 * histogram derived from the group's DDSketch. Errors carry status.code=ERROR; top-level is conveyed
 * via the per-group dd.span.top_level attribute (true only when every hit was top-level), which (like
 * all dd.* attributes) is omitted in OTel-semantics mode. Data points with count=0 are omitted.
 *
 * Service identity (service.name/service.version/deployment.environment.name) is carried on the
 * resource. A span whose service differs from the configured default service additionally carries
 * service.name on its data point.
 *
 * @class OtlpStatsTransformer
 * @augments OtlpTransformerBase
 */
class OtlpStatsTransformer extends OtlpTransformerBase {
  #otelSemanticsEnabled
  #defaultService

  /**
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource attributes
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {boolean} [otelSemanticsEnabled] - When true, only OTel attributes are emitted (no dd.*)
   * @param {string} [defaultService] - The configured default service (DD_SERVICE), reported on the
   *   resource. A data point carries service.name only when its span's service differs from this.
   */
  constructor (resourceAttributes, protocol, otelSemanticsEnabled = false, defaultService = '') {
    super(resourceAttributes, protocol, 'span-stats')
    this.#otelSemanticsEnabled = otelSemanticsEnabled
    this.#defaultService = defaultService
  }

  /**
   * Transforms drained span stat buckets to an OTLP metrics payload.
   *
   * @param {Array<{timeNs: number, bucket: import('../../span_stats').SpanBuckets}>} drained
   * @param {number} bucketSizeNs - Bucket duration in nanoseconds
   * @returns {Buffer} Serialized OTLP ExportMetricsServiceRequest
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
        // Per-group top-level heuristic: a group is top-level only when every hit was top-level.
        const topLevel = aggStats.hits > 0 && aggStats.topLevelHits === aggStats.hits
        const attrs = this.#otelSemanticsEnabled
          ? baseAttrs
          : [...baseAttrs, { key: 'datadog.span.top_level', value: { boolValue: topLevel } }]

        this.#pushPoint(dataPoints, aggStats.okDistribution, startNano, endNano, attrs)
        this.#pushPoint(dataPoints, aggStats.errorDistribution, startNano, endNano, [...attrs, ERROR_STATUS_ATTR])
      }
    }

    if (dataPoints.length === 0) return []
    return [{
      metrics: [
        {
          name: 'traces.span.sdk.metrics.duration',
          description: '',
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
   * Builds the shared OTLP data point attributes for an aggregation key. OTel semantic-convention
   * attributes are emitted in both modes; Datadog datadog.* attributes are added only in default mode.
   * Values are emitted with their native OTLP types (e.g. the HTTP status code as an int).
   *
   * @param {import('../../span_stats').SpanAggKey} aggKey
   * @returns {object[]}
   */
  #buildAttributes (aggKey) {
    const raw = { 'span.name': aggKey.resource }

    if (aggKey.service && aggKey.service !== this.#defaultService) {
      raw['service.name'] = aggKey.service
    }

    if (aggKey.spanKind) raw['span.kind'] = aggKey.spanKind
    if (aggKey.statusCode) raw['http.response.status_code'] = Number(aggKey.statusCode)
    if (aggKey.method) raw['http.request.method'] = aggKey.method
    if (aggKey.endpoint) raw['http.route'] = aggKey.endpoint
    if (aggKey.rpcStatusCode !== undefined && aggKey.rpcStatusCode !== '') {
      const code = Number(aggKey.rpcStatusCode)
      raw['rpc.response.status_code'] = Number.isNaN(code) ? aggKey.rpcStatusCode : code
    }

    if (!this.#otelSemanticsEnabled) {
      raw['datadog.operation.name'] = aggKey.name
      if (aggKey.type) raw['datadog.span.type'] = aggKey.type
      if (aggKey.origin) raw['datadog.origin'] = aggKey.origin
    }

    return this.transformAttributes(raw)
  }
}

module.exports = OtlpStatsTransformer
module.exports.EXPLICIT_BOUNDS_SECONDS = EXPLICIT_BOUNDS_SECONDS
