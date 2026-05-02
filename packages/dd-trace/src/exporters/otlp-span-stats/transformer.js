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
 * Emits 4 metrics (all delta temporality):
 *   - dd.trace.span.hits            (Sum, monotonic)
 *   - dd.trace.span.errors          (Sum, monotonic)
 *   - dd.trace.span.top_level_hits  (Sum, monotonic)
 *   - dd.trace.span.duration        (Histogram, split by error=true/false)
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
    const hitsPoints = []
    const errorsPoints = []
    const topLevelHitsPoints = []
    const durationPoints = []

    const temporality = isJson ? 'AGGREGATION_TEMPORALITY_DELTA' : getDeltaTemporality()

    for (const { timeNs, bucket } of drained) {
      const endTimeNs = timeNs + bucketSizeNs
      const startNano = isJson ? String(timeNs) : timeNs
      const endNano = isJson ? String(endTimeNs) : endTimeNs

      for (const aggStats of bucket.values()) {
        const { aggKey, hits, errors, topLevelHits, duration, errorDuration } = aggStats
        const baseAttrs = this.#buildAttributes(aggKey, isJson)

        hitsPoints.push({
          attributes: baseAttrs,
          startTimeUnixNano: startNano,
          timeUnixNano: endNano,
          asInt: hits,
        })

        errorsPoints.push({
          attributes: baseAttrs,
          startTimeUnixNano: startNano,
          timeUnixNano: endNano,
          asInt: errors,
        })

        topLevelHitsPoints.push({
          attributes: baseAttrs,
          startTimeUnixNano: startNano,
          timeUnixNano: endNano,
          asInt: topLevelHits,
        })

        const okCount = hits - errors
        const okDuration = duration - errorDuration

        if (okCount > 0) {
          durationPoints.push({
            attributes: [...baseAttrs, this.#boolAttr('error', false, isJson)],
            startTimeUnixNano: startNano,
            timeUnixNano: endNano,
            count: okCount,
            sum: okDuration / NS_PER_S,
            bucketCounts: [],
            explicitBounds: [],
          })
        }

        if (errors > 0) {
          durationPoints.push({
            attributes: [...baseAttrs, this.#boolAttr('error', true, isJson)],
            startTimeUnixNano: startNano,
            timeUnixNano: endNano,
            count: errors,
            sum: errorDuration / NS_PER_S,
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
          name: 'dd.trace.span.hits',
          description: '',
          unit: '{span}',
          sum: { dataPoints: hitsPoints, aggregationTemporality: temporality, isMonotonic: true },
        },
        {
          name: 'dd.trace.span.errors',
          description: '',
          unit: '{span}',
          sum: { dataPoints: errorsPoints, aggregationTemporality: temporality, isMonotonic: true },
        },
        {
          name: 'dd.trace.span.top_level_hits',
          description: '',
          unit: '{span}',
          sum: { dataPoints: topLevelHitsPoints, aggregationTemporality: temporality, isMonotonic: true },
        },
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
      'span.name': aggKey.name,
      'dd.resource': aggKey.resource,
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
