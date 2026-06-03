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

/**
 * Transforms span stats bucket data into an OTLP ExportMetricsServiceRequest.
 *
 * Emits a single histogram metric (delta temporality):
 *   - dd.trace.span.duration (Histogram, split by dd.top_level and error=true)
 *
 * Each aggregation key emits up to 4 data points covering the (ok/error) × (not-top-level/top-level) matrix:
 *   { dd.top_level: false }                      — ok, not top-level
 *   { dd.top_level: true  }                      — ok, top-level
 *   { error: true, dd.top_level: false }          — error, not top-level
 *   { error: true, dd.top_level: true  }          — error, top-level
 *
 * The `error` attribute is only added when error=true; ok data points carry no error attribute.
 * Data points with count=0 are omitted.
 *
 * @class OtlpStatsTransformer
 * @augments OtlpTransformerBase
 */
class OtlpStatsTransformer extends OtlpTransformerBase {
  /**
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource attributes
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   */
  constructor (resourceAttributes, protocol) {
    super(resourceAttributes, protocol, 'span-stats')
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

        this.#pushPoint(durationPoints, cells.okNotTopLevel, startNano, endNano, [
          ...baseAttrs, this.#boolAttr('dd.top_level', false),
        ])
        this.#pushPoint(durationPoints, cells.okTopLevel, startNano, endNano, [
          ...baseAttrs, this.#boolAttr('dd.top_level', true),
        ])
        this.#pushPoint(durationPoints, cells.errNotTopLevel, startNano, endNano, [
          ...baseAttrs, this.#boolAttr('error', true), this.#boolAttr('dd.top_level', false),
        ])
        this.#pushPoint(durationPoints, cells.errTopLevel, startNano, endNano, [
          ...baseAttrs, this.#boolAttr('error', true), this.#boolAttr('dd.top_level', true),
        ])
      }
    }

    return {
      scope: SCOPE,
      schemaUrl: '',
      metrics: [
        {
          name: 'dd.trace.span.duration',
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
   * Builds OTLP data point attributes from an aggregation key. Values are emitted with their
   * native OTLP types (e.g. the HTTP status code as an int, synthetics as a bool).
   *
   * @param {import('../../span_stats').SpanAggKey} aggKey
   * @returns {object[]}
   */
  #buildAttributes (aggKey) {
    const raw = {
      'span.name': aggKey.resource,
      'dd.operation.name': aggKey.name,
      'dd.span.type': aggKey.type,
      'dd.synthetics': aggKey.synthetics,
    }

    if (aggKey.statusCode) raw['http.response.status_code'] = Number(aggKey.statusCode)
    if (aggKey.method) raw['http.request.method'] = aggKey.method
    if (aggKey.endpoint) raw['http.route'] = aggKey.endpoint

    return this.transformAttributes(raw)
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
