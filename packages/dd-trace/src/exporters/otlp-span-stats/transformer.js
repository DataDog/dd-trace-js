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
        const { aggKey, hits, errors, topLevelHits, topLevelErrors, duration, errorDuration,
          topLevelDuration, topLevelErrorDuration } = aggStats
        const baseAttrs = this.#buildAttributes(aggKey, isJson)

        // Derive the 4 cells of the (ok/error) × (not-top-level/top-level) matrix.
        const okNotTopLevel = hits - errors - (topLevelHits - topLevelErrors)
        const okTopLevel = topLevelHits - topLevelErrors
        const errNotTopLevel = errors - topLevelErrors
        const errTopLevel = topLevelErrors

        const okNotTopLevelDur = (duration - errorDuration) - (topLevelDuration - topLevelErrorDuration)
        const okTopLevelDur = topLevelDuration - topLevelErrorDuration
        const errNotTopLevelDur = errorDuration - topLevelErrorDuration
        const errTopLevelDur = topLevelErrorDuration

        if (okNotTopLevel > 0) {
          durationPoints.push({
            attributes: [...baseAttrs, this.#boolAttr('dd.top_level', false, isJson)],
            startTimeUnixNano: startNano,
            timeUnixNano: endNano,
            count: okNotTopLevel,
            sum: okNotTopLevelDur / NS_PER_S,
            bucketCounts: [],
            explicitBounds: [],
          })
        }

        if (okTopLevel > 0) {
          durationPoints.push({
            attributes: [...baseAttrs, this.#boolAttr('dd.top_level', true, isJson)],
            startTimeUnixNano: startNano,
            timeUnixNano: endNano,
            count: okTopLevel,
            sum: okTopLevelDur / NS_PER_S,
            bucketCounts: [],
            explicitBounds: [],
          })
        }

        if (errNotTopLevel > 0) {
          durationPoints.push({
            attributes: [
              ...baseAttrs,
              this.#boolAttr('error', true, isJson),
              this.#boolAttr('dd.top_level', false, isJson),
            ],
            startTimeUnixNano: startNano,
            timeUnixNano: endNano,
            count: errNotTopLevel,
            sum: errNotTopLevelDur / NS_PER_S,
            bucketCounts: [],
            explicitBounds: [],
          })
        }

        if (errTopLevel > 0) {
          durationPoints.push({
            attributes: [
              ...baseAttrs,
              this.#boolAttr('error', true, isJson),
              this.#boolAttr('dd.top_level', true, isJson),
            ],
            startTimeUnixNano: startNano,
            timeUnixNano: endNano,
            count: errTopLevel,
            sum: errTopLevelDur / NS_PER_S,
            bucketCounts: [],
            explicitBounds: [],
          })
        }
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
   * Builds OTLP data point attributes from an aggregation key.
   *
   * @param {import('../../span_stats').SpanAggKey} aggKey
   * @param {boolean} isJson
   * @returns {object[]}
   */
  #buildAttributes (aggKey, isJson) {
    const raw = {
      'span.name': aggKey.resource,
      'dd.operation.name': aggKey.name,
      'dd.span.type': aggKey.type,
      'dd.synthetics': aggKey.synthetics,
    }

    if (aggKey.statusCode) raw['http.response.status_code'] = aggKey.statusCode
    if (aggKey.method) raw['http.request.method'] = aggKey.method
    if (aggKey.endpoint) raw['http.route'] = aggKey.endpoint

    return isJson ? this.attributesToJson(raw) : this.transformAttributes(raw)
  }

  /**
   * @param {string} key
   * @param {boolean} value
   * @param {boolean} isJson
   * @returns {object}
   */
  #boolAttr (key, value, isJson) {
    if (isJson) {
      return { key, value: { stringValue: String(value) } }
    }
    return { key, value: { boolValue: value } }
  }
}

module.exports = OtlpStatsTransformer
