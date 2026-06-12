'use strict'

const OtlpTransformerBase = require('../../opentelemetry/otlp/otlp_transformer_base')
const { getProtobufTypes } = require('../../opentelemetry/otlp/protobuf_loader')
const { VERSION } = require('../../../../../version')

const NS_PER_S = 1e9

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
 * Each aggregation key emits up to 4 data points covering the (ok/error) × (not-top-level/top-level)
 * matrix. Errors carry status.code=ERROR; top-level is conveyed via the dd.span.top_level attribute,
 * which (like all dd.* attributes) is omitted in OTel-semantics mode. Data points with count=0 are omitted.
 *
 * @class OtlpStatsTransformer
 * @augments OtlpTransformerBase
 */
class OtlpStatsTransformer extends OtlpTransformerBase {
  #otelSemanticsEnabled

  /**
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource attributes
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {boolean} [otelSemanticsEnabled] - When true, only OTel attributes are emitted (no dd.*)
   */
  constructor (resourceAttributes, protocol, otelSemanticsEnabled = false) {
    super(resourceAttributes, protocol, 'span-stats')
    this.#otelSemanticsEnabled = otelSemanticsEnabled
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
        scopeMetrics: [this.#buildScopeMetrics(drained, bucketSizeNs, false)],
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
        scopeMetrics: [this.#buildScopeMetrics(drained, bucketSizeNs, true)],
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
    const durationPoints = []

    const temporality = isJson ? 'AGGREGATION_TEMPORALITY_DELTA' : getDeltaTemporality()

    for (const { timeNs, bucket } of drained) {
      const endTimeNs = timeNs + bucketSizeNs
      const startNano = isJson ? String(timeNs) : timeNs
      const endNano = isJson ? String(endTimeNs) : endTimeNs

      for (const aggStats of bucket.values()) {
        const { aggKey, cells } = aggStats
        const baseAttrs = this.#buildAttributes(aggKey)
        const dd = !this.#otelSemanticsEnabled
        const error = this.#errorStatus()

        this.#pushPoint(durationPoints, cells.okNotTopLevel, startNano, endNano,
          dd ? [...baseAttrs, this.#boolAttr('dd.span.top_level', false)] : baseAttrs)
        this.#pushPoint(durationPoints, cells.okTopLevel, startNano, endNano,
          dd ? [...baseAttrs, this.#boolAttr('dd.span.top_level', true)] : baseAttrs)
        this.#pushPoint(durationPoints, cells.errNotTopLevel, startNano, endNano,
          dd ? [...baseAttrs, error, this.#boolAttr('dd.span.top_level', false)] : [...baseAttrs, error])
        this.#pushPoint(durationPoints, cells.errTopLevel, startNano, endNano,
          dd ? [...baseAttrs, error, this.#boolAttr('dd.span.top_level', true)] : [...baseAttrs, error])
      }
    }

    return {
      scope: SCOPE,
      schemaUrl: '',
      metrics: [
        {
          name: 'traces.span.sdk.metrics.duration',
          description: '',
          unit: 's',
          histogram: { dataPoints: durationPoints, aggregationTemporality: temporality },
        },
      ],
    }
  }

  /**
   * Appends a histogram data point for a non-empty cell. Durations are converted from
   * nanoseconds to seconds. A single (unbounded) bucket holds the full count.
   *
   * @param {object[]} points
   * @param {import('../../span_stats').HistogramCell} cell
   * @param {string|number} startNano
   * @param {string|number} endNano
   * @param {object[]} attributes
   * @returns {void}
   */
  #pushPoint (points, cell, startNano, endNano, attributes) {
    if (!cell || cell.count === 0) return
    points.push({
      attributes,
      startTimeUnixNano: startNano,
      timeUnixNano: endNano,
      count: cell.count,
      sum: cell.sum / NS_PER_S,
      min: cell.min / NS_PER_S,
      max: cell.max / NS_PER_S,
      bucketCounts: [cell.count],
      explicitBounds: [],
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
