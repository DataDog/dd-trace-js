'use strict'

const OtlpTransformerBase = require('../../opentelemetry/otlp/otlp_transformer_base')
const { getProtobufTypes } = require('../../opentelemetry/otlp/protobuf_loader')
const { VERSION } = require('../../../../../version')

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
 * @returns {{ bucketCounts: number[], explicitBounds: number[] }}
 */
function sketchToFixedHistogram (sketch) {
  const bucketCounts = new Array(EXPLICIT_BOUNDS_SECONDS.length + 1).fill(0)
  if (sketch.zeroCount > 0) bucketCounts[0] += sketch.zeroCount
  const { store, mapping } = sketch
  for (let key = store.minKey; key <= store.maxKey; key++) {
    const weight = store.bins[key - store.offset]
    if (!weight || weight <= 0) continue
    const seconds = mapping.value(key) / NS_PER_S
    let idx = EXPLICIT_BOUNDS_SECONDS.findIndex((bound) => seconds <= bound)
    if (idx === -1) idx = EXPLICIT_BOUNDS_SECONDS.length
    bucketCounts[idx] += weight
  }
  return {
    bucketCounts: bucketCounts.map((weight) => Math.round(weight)),
    explicitBounds: EXPLICIT_BOUNDS_SECONDS,
  }
}

const SCOPE = { name: 'dd-trace', version: VERSION }

// Cached at module load time since protobuf types are initialized once.
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
const STATUS_CODE_ERROR = 2

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
 * @class OtlpStatsTransformer
 * @augments OtlpTransformerBase
 */
class OtlpStatsTransformer extends OtlpTransformerBase {
  #otelSemanticsEnabled
  #scopeIdentity

  /**
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource attributes
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {boolean} [otelSemanticsEnabled] - When true, only OTel attributes are emitted (no dd.*)
   * @param {{ env?: string, serviceVersion?: string }} [scopeIdentity] - Scope-level identity
   *   attributes shared across services (service.name comes from each aggregation key)
   */
  constructor (resourceAttributes, protocol, otelSemanticsEnabled = false, scopeIdentity = {}) {
    super(resourceAttributes, protocol, 'span-stats')
    this.#otelSemanticsEnabled = otelSemanticsEnabled
    this.#scopeIdentity = scopeIdentity
  }

  /**
   * Transforms drained span stat buckets to an OTLP metrics payload.
   *
   * @param {Array<{timeNs: number, bucket: import('../../span_stats').SpanBuckets}>} drained
   * @param {number} bucketSizeNs - Bucket duration in nanoseconds
   * @returns {Buffer} Serialized OTLP ExportMetricsServiceRequest
   */
  transform (drained, bucketSizeNs) {
    if (this.protocol === 'http/json') {
      return this.#transformToJson(drained, bucketSizeNs)
    }
    return this.#transformToProtobuf(drained, bucketSizeNs)
  }

  /**
   * @param {Array} drained
   * @param {number} bucketSizeNs
   * @returns {Buffer}
   */
  #transformToProtobuf (drained, bucketSizeNs) {
    const { protoMetricsService } = getProtobufTypes()
    const data = {
      resourceMetrics: [{
        resource: this.transformResource(),
        scopeMetrics: this.#buildScopeMetrics(drained, bucketSizeNs, false),
      }],
    }
    return this.serializeToProtobuf(protoMetricsService, data)
  }

  /**
   * @param {Array} drained
   * @param {number} bucketSizeNs
   * @returns {Buffer}
   */
  #transformToJson (drained, bucketSizeNs) {
    const data = {
      resourceMetrics: [{
        resource: this.transformResource(),
        scopeMetrics: this.#buildScopeMetrics(drained, bucketSizeNs, true),
      }],
    }
    return this.serializeToJson(data)
  }

  /**
   * @param {Array} drained
   * @param {number} bucketSizeNs
   * @param {boolean} isJson
   * @returns {object}
   */
  #buildScopeMetrics (drained, bucketSizeNs, isJson) {
    const temporality = isJson ? 'AGGREGATION_TEMPORALITY_DELTA' : getDeltaTemporality()

    // Partition data points by service so each service maps to its own InstrumentationScope,
    // letting a single payload carry multiple services.
    const pointsByService = new Map()

    for (const { timeNs, bucket } of drained) {
      const endTimeNs = timeNs + bucketSizeNs
      const startNano = isJson ? String(timeNs) : timeNs
      const endNano = isJson ? String(endTimeNs) : endTimeNs

      for (const aggStats of bucket.values()) {
        const { aggKey } = aggStats
        let points = pointsByService.get(aggKey.service)
        if (points === undefined) {
          points = []
          pointsByService.set(aggKey.service, points)
        }
        const baseAttrs = this.#buildAttributes(aggKey)
        // Per-group top-level heuristic: a group is top-level only when every hit was top-level.
        const topLevel = aggStats.hits > 0 && aggStats.topLevelHits === aggStats.hits
        const attrs = this.#otelSemanticsEnabled
          ? baseAttrs
          : [...baseAttrs, this.#boolAttr('dd.span.top_level', topLevel)]

        this.#pushPoint(points, aggStats.okDistribution, startNano, endNano, attrs)
        this.#pushPoint(points, aggStats.errorDistribution, startNano, endNano, [...attrs, this.#errorStatus()])
      }
    }

    const scopeMetrics = []
    for (const [service, dataPoints] of pointsByService) {
      if (dataPoints.length === 0) continue
      scopeMetrics.push({
        scope: this.#buildScope(service),
        schemaUrl: '',
        metrics: [
          {
            name: 'traces.span.sdk.metrics.duration',
            description: '',
            unit: 's',
            histogram: { dataPoints, aggregationTemporality: temporality },
          },
        ],
      })
    }
    return scopeMetrics
  }

  /**
   * Builds an InstrumentationScope carrying the service identity. service.name partitions the
   * scope; service.version and deployment.environment.name are global. All are OTel attributes.
   *
   * @param {string} service
   * @returns {object}
   */
  #buildScope (service) {
    const raw = { 'service.name': service }
    const { serviceVersion, env } = this.#scopeIdentity
    if (serviceVersion) raw['service.version'] = serviceVersion
    if (env) raw['deployment.environment.name'] = env
    return { name: SCOPE.name, version: SCOPE.version, attributes: this.transformAttributes(raw) }
  }

  /**
   * Appends a fixed explicit-bounds histogram data point derived from a non-empty sketch. count/sum/
   * min/max use the sketch's exact scalars; bucket counts are bucketed from its bins. Durations are
   * converted from nanoseconds to seconds.
   *
   * @param {object[]} points
   * @param {object} sketch - A LogCollapsingLowestDenseDDSketch
   * @param {string|number} startNano
   * @param {string|number} endNano
   * @param {object[]} attributes
   * @returns {void}
   */
  #pushPoint (points, sketch, startNano, endNano, attributes) {
    if (!sketch || sketch.count === 0) return
    const { bucketCounts, explicitBounds } = sketchToFixedHistogram(sketch)
    points.push({
      attributes,
      startTimeUnixNano: startNano,
      timeUnixNano: endNano,
      count: sketch.count,
      sum: sketch.sum / NS_PER_S,
      min: sketch.min / NS_PER_S,
      max: sketch.max / NS_PER_S,
      bucketCounts,
      explicitBounds,
    })
  }

  /**
   * Builds the shared OTLP data point attributes for an aggregation key. OTel semantic-convention
   * attributes are emitted in both modes; Datadog dd.* attributes are added only in default mode.
   * Values are emitted with their native OTLP types (e.g. the HTTP status code as an int).
   *
   * @param {import('../../span_stats').SpanAggKey} aggKey
   * @returns {object[]}
   */
  #buildAttributes (aggKey) {
    const raw = { 'span.name': aggKey.resource }

    if (aggKey.spanKind) raw['span.kind'] = aggKey.spanKind
    if (aggKey.statusCode) raw['http.response.status_code'] = Number(aggKey.statusCode)
    if (aggKey.method) raw['http.request.method'] = aggKey.method
    if (aggKey.endpoint) raw['http.route'] = aggKey.endpoint
    if (aggKey.rpcMethod) raw['rpc.method'] = aggKey.rpcMethod
    if (aggKey.rpcStatusCode !== undefined && aggKey.rpcStatusCode !== '') {
      const code = Number(aggKey.rpcStatusCode)
      raw['rpc.response.status_code'] = Number.isNaN(code) ? aggKey.rpcStatusCode : code
    }

    if (!this.#otelSemanticsEnabled) {
      raw['dd.operation.name'] = aggKey.name
      if (aggKey.type) raw['dd.span.type'] = aggKey.type
      if (aggKey.origin) raw['dd.origin'] = aggKey.origin
    }

    return this.transformAttributes(raw)
  }

  /**
   * @returns {object} status.code attribute denoting an error span status.
   */
  #errorStatus () {
    return { key: 'status.code', value: { intValue: STATUS_CODE_ERROR } }
  }

  /**
   * @param {string} key
   * @param {boolean} value
   * @returns {object}
   */
  #boolAttr (key, value) {
    return { key, value: { boolValue: value } }
  }
}

module.exports = OtlpStatsTransformer
module.exports.EXPLICIT_BOUNDS_SECONDS = EXPLICIT_BOUNDS_SECONDS
