'use strict'

const { version: tracerVersion } = require('../../pkg')
const OtlpTransformerBase = require('../../opentelemetry/otlp/otlp_transformer_base')
const { getProtobufTypes } = require('../../opentelemetry/otlp/protobuf_loader')

const NS_PER_SECOND = 1e9

/**
 * @typedef {import('../../../span_stats').SpanBuckets} SpanBuckets
 * @typedef {import('../../../span_stats').SpanAggStats} SpanAggStats
 * @typedef {{ timeNs: number, bucket: SpanBuckets }} DrainedBucket
 */

/**
 * Transforms raw span bucket data to OTLP ExportMetricsServiceRequest format.
 *
 * Emits four metrics per flush (all delta temporality):
 *   - dd.trace.span.hits          (Sum, monotonic)
 *   - dd.trace.span.errors        (Sum, monotonic)
 *   - dd.trace.span.top_level_hits (Sum, monotonic)
 *   - dd.trace.span.duration      (Histogram, split by error=true/false)
 *
 * @class OtlpStatsTransformer
 * @augments OtlpTransformerBase
 */
class OtlpStatsTransformer extends OtlpTransformerBase {
  /**
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource-level attributes
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {string} histogramType - Histogram encoding: 'explicit' | 'exponential'
   */
  constructor (resourceAttributes, protocol, histogramType) {
    super(resourceAttributes, protocol, 'span-stats')
    this.histogramType = histogramType
  }

  /**
   * Transforms drained bucket data to a serialized OTLP payload.
   *
   * @param {DrainedBucket[]} drained - Raw drained bucket entries
   * @param {number} bucketSizeNs - Bucket duration in nanoseconds
   * @returns {Buffer} Serialized OTLP payload (protobuf or JSON)
   */
  transform (drained, bucketSizeNs) {
    const isJson = this.protocol === 'http/json'

    const metricsData = {
      resourceMetrics: [{
        resource: this.transformResource(),
        scopeMetrics: [{
          scope: {
            name: 'dd-trace',
            version: tracerVersion,
            droppedAttributesCount: 0,
          },
          metrics: this.#buildMetrics(drained, bucketSizeNs, isJson),
        }],
      }],
    }

    if (isJson) {
      return this.serializeToJson(metricsData)
    }
    const { protoMetricsService } = getProtobufTypes()
    return this.serializeToProtobuf(protoMetricsService, metricsData)
  }

  /**
   * Builds all four OTLP Metric objects from drained buckets.
   *
   * @param {DrainedBucket[]} drained
   * @param {number} bucketSizeNs
   * @param {boolean} isJson
   * @returns {object[]} Array of OTLP Metric objects
   */
  #buildMetrics (drained, bucketSizeNs, isJson) {
    const hitsDataPoints = []
    const errorsDataPoints = []
    const topLevelHitsDataPoints = []
    const durationDataPoints = []

    const { protoAggregationTemporality } = isJson ? {} : getProtobufTypes()
    const TEMPORALITY_DELTA = isJson
      ? 'AGGREGATION_TEMPORALITY_DELTA'
      : protoAggregationTemporality.values.AGGREGATION_TEMPORALITY_DELTA

    for (const { timeNs, bucket } of drained) {
      const startTimeNs = timeNs
      const endTimeNs = timeNs + bucketSizeNs

      for (const aggStats of bucket.values()) {
        const { aggKey } = aggStats
        const attrs = isJson
          ? this.attributesToJson(this.#buildDataPointAttributes(aggKey))
          : this.transformAttributes(this.#buildDataPointAttributes(aggKey))

        const startNs = isJson ? String(startTimeNs) : startTimeNs
        const endNs = isJson ? String(endTimeNs) : endTimeNs

        hitsDataPoints.push({
          attributes: attrs,
          startTimeUnixNano: startNs,
          timeUnixNano: endNs,
          asInt: aggStats.hits,
        })

        errorsDataPoints.push({
          attributes: attrs,
          startTimeUnixNano: startNs,
          timeUnixNano: endNs,
          asInt: aggStats.errors,
        })

        topLevelHitsDataPoints.push({
          attributes: attrs,
          startTimeUnixNano: startNs,
          timeUnixNano: endNs,
          asInt: aggStats.topLevelHits,
        })

        const okCount = aggStats.hits - aggStats.errors
        if (okCount > 0) {
          durationDataPoints.push(
            this.#buildDurationDataPoint(aggKey, aggStats.okDistribution, false, startNs, endNs, okCount, isJson)
          )
        }
        if (aggStats.errors > 0) {
          const errorDp = this.#buildDurationDataPoint(
            aggKey, aggStats.errorDistribution, true, startNs, endNs, aggStats.errors, isJson
          )
          durationDataPoints.push(errorDp)
        }
      }
    }

    return [
      {
        name: 'dd.trace.span.hits',
        description: 'Total span count per aggregation key',
        unit: '{span}',
        sum: {
          dataPoints: hitsDataPoints,
          aggregationTemporality: TEMPORALITY_DELTA,
          isMonotonic: true,
        },
      },
      {
        name: 'dd.trace.span.errors',
        description: 'Error span count per aggregation key',
        unit: '{span}',
        sum: {
          dataPoints: errorsDataPoints,
          aggregationTemporality: TEMPORALITY_DELTA,
          isMonotonic: true,
        },
      },
      {
        name: 'dd.trace.span.top_level_hits',
        description: 'Top-level span count per aggregation key',
        unit: '{span}',
        sum: {
          dataPoints: topLevelHitsDataPoints,
          aggregationTemporality: TEMPORALITY_DELTA,
          isMonotonic: true,
        },
      },
      {
        name: 'dd.trace.span.duration',
        description: 'Span duration distribution per aggregation key',
        unit: 's',
        histogram: {
          dataPoints: durationDataPoints,
          aggregationTemporality: TEMPORALITY_DELTA,
        },
      },
    ]
  }

  /**
   * Builds per-datapoint OTLP attributes from a span aggregation key.
   *
   * @param {import('../../span_stats').SpanAggKey} aggKey
   * @returns {object} Plain attributes object
   */
  #buildDataPointAttributes (aggKey) {
    const attrs = {
      'span.name': aggKey.name,
      'dd.resource': aggKey.resource,
      'dd.span.type': aggKey.type,
      'dd.synthetics': aggKey.synthetics,
    }

    if (aggKey.statusCode) {
      attrs['http.response.status_code'] = aggKey.statusCode
    }
    if (aggKey.method) {
      attrs['http.request.method'] = aggKey.method
    }
    if (aggKey.endpoint) {
      attrs['http.route'] = aggKey.endpoint
    }

    return attrs
  }

  /**
   * Builds a single OTLP Histogram data point from a DDSketch distribution.
   *
   * For 'explicit' histogram type: emits count/sum/min/max with empty buckets.
   * Full bucket subdivision is deferred to a follow-up spec (Open Q #1 in RFC).
   *
   * For 'exponential' histogram type: currently falls back to explicit with a warning.
   *
   * @param {import('../../span_stats').SpanAggKey} aggKey
   * @param {import('@datadog/sketches-js').LogCollapsingLowestDenseDDSketch} sketch
   * @param {boolean} isError
   * @param {number|string} startTimeNs
   * @param {number|string} endTimeNs
   * @param {number} count
   * @param {boolean} isJson
   * @returns {object} OTLP HistogramDataPoint
   */
  #buildDurationDataPoint (aggKey, sketch, isError, startTimeNs, endTimeNs, count, isJson) {
    const attrs = { ...this.#buildDataPointAttributes(aggKey), error: isError }
    const attributes = isJson ? this.attributesToJson(attrs) : this.transformAttributes(attrs)

    // Convert nanoseconds to seconds per OTel semconv
    const sumSeconds = sketch.sum / NS_PER_SECOND
    const minSeconds = sketch.min / NS_PER_SECOND
    const maxSeconds = sketch.max / NS_PER_SECOND

    const dataPoint = {
      attributes,
      startTimeUnixNano: startTimeNs,
      timeUnixNano: endTimeNs,
      count: isJson ? count : count,
      sum: sumSeconds,
      bucketCounts: [],
      explicitBounds: [],
      min: minSeconds,
      max: maxSeconds,
    }

    if (isJson) {
      dataPoint.count = count
    }

    return dataPoint
  }
}

module.exports = OtlpStatsTransformer
