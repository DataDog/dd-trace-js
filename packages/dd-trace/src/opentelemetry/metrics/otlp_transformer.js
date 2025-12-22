'use strict'

const OtlpTransformerBase = require('../otlp/otlp_transformer_base')
const { getProtobufTypes } = require('../otlp/protobuf_loader')
const { METRIC_TYPES, TEMPORALITY } = require('./constants')

const { protoAggregationTemporality } = getProtobufTypes()
const AGGREGATION_TEMPORALITY_DELTA = protoAggregationTemporality.values.AGGREGATION_TEMPORALITY_DELTA
const AGGREGATION_TEMPORALITY_CUMULATIVE = protoAggregationTemporality.values.AGGREGATION_TEMPORALITY_CUMULATIVE

/**
 * @typedef {import('./periodic_metric_reader').AggregatedMetric} AggregatedMetric
 * @typedef {import('./periodic_metric_reader').NumberDataPoint} NumberDataPoint
 * @typedef {import('./periodic_metric_reader').HistogramDataPoint} HistogramDataPoint
 */

/**
 * OtlpTransformer transforms metrics to OTLP format.
 *
 * This implementation follows the OTLP Metrics v1.7.0 Data Model specification:
 * https://opentelemetry.io/docs/specs/otlp/#metrics-data-model
 *
 * @class OtlpTransformer
 * @augments OtlpTransformerBase
 */
class OtlpTransformer extends OtlpTransformerBase {
  /**
   * Creates a new OtlpTransformer instance.
   *
   * @param {import('@opentelemetry/api').Attributes} resourceAttributes - Resource attributes
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   */
  constructor (resourceAttributes, protocol) {
    super(resourceAttributes, protocol, 'metrics')
  }

  /**
   * Transforms metrics to OTLP format based on the configured protocol.
   * @param {Iterable<AggregatedMetric>} metrics - Iterable of metric data to transform
   * @returns {Buffer} Transformed metrics in the appropriate format
   */
  transformMetrics (metrics) {
    if (this.protocol === 'http/json') {
      return this.#transformToJson(metrics)
    }
    return this.#transformToProtobuf(metrics)
  }

  /**
   * Transforms metrics to protobuf format.
   * @param {Iterable<AggregatedMetric>} metrics - Iterable of metrics to transform
   * @returns {Buffer} Protobuf-encoded metrics
   *
   */
  #transformToProtobuf (metrics) {
    const { protoMetricsService } = getProtobufTypes()

    const metricsData = {
      resourceMetrics: [{
        resource: this.transformResource(),
        scopeMetrics: this.#transformScope(metrics),
      }]
    }

    return this.serializeToProtobuf(protoMetricsService, metricsData)
  }

  /**
   * Transforms metrics to JSON format.
   * @param {Array} metrics - Array of metrics to transform
   * @returns {Buffer} JSON-encoded metrics
   *
   */
  #transformToJson (metrics) {
    const metricsData = {
      resourceMetrics: [{
        resource: this.transformResource(),
        scopeMetrics: this.#transformScope(metrics, true)
      }]
    }
    return this.serializeToJson(metricsData)
  }

  /**
   * Creates scope metrics grouped by instrumentation scope.
   * @param {Iterable<AggregatedMetric>} metrics - Iterable of metrics to transform
   * @param {boolean} isJson - Whether to format for JSON output
   * @returns {Array<Object>} Array of scope metric objects
   *
   */
  #transformScope (metrics, isJson = false) {
    const groupedMetrics = this.groupByInstrumentationScope(metrics)
    const scopeMetrics = []

    for (const metricsInScope of groupedMetrics.values()) {
      const firstMetric = metricsInScope[0]
      const instrumentationScope = firstMetric.instrumentationScope || {}
      const { name = '', version = '', schemaUrl = '', attributes = {} } = instrumentationScope

      const scope = {
        name,
        version,
        droppedAttributesCount: 0
      }

      if (attributes) {
        const transformed = isJson ? this.attributesToJson(attributes) : this.transformAttributes(attributes)
        if (transformed.length) {
          scope.attributes = transformed
        }
      }

      scopeMetrics.push({
        scope,
        schemaUrl,
        metrics: metricsInScope.map(metric => this.#transformMetric(metric, isJson))
      })
    }

    return scopeMetrics
  }

  /**
   * Transforms a single metric to protobuf or JSON format.
   *
   * @param {AggregatedMetric} metric - The metric to transform
   * @param {boolean} isJson - Whether to output JSON format (vs protobuf)
   * @returns {Object} - The metric transformed to OTLP protobuf or JSON format
   */
  #transformMetric (metric, isJson = false) {
    const result = {
      name: metric.name,
      description: metric.description || '',
      unit: metric.unit || ''
    }

    const isCumulative = metric.temporality === TEMPORALITY.CUMULATIVE
    let temporality
    if (isJson) {
      temporality = isCumulative ? 'AGGREGATION_TEMPORALITY_CUMULATIVE' : 'AGGREGATION_TEMPORALITY_DELTA'
    } else {
      temporality = isCumulative ? AGGREGATION_TEMPORALITY_CUMULATIVE : AGGREGATION_TEMPORALITY_DELTA
    }

    switch (metric.type) {
      case METRIC_TYPES.HISTOGRAM:
        result.histogram = {
          dataPoints: Array.from(metric.dataPointMap.values(), dp => this.#transformHistogramDataPoint(dp, isJson)),
          aggregationTemporality: temporality
        }
        break

      case METRIC_TYPES.COUNTER:
      case METRIC_TYPES.OBSERVABLECOUNTER:
      case METRIC_TYPES.UPDOWNCOUNTER:
      case METRIC_TYPES.OBSERVABLEUPDOWNCOUNTER:
        result.sum = {
          dataPoints: Array.from(metric.dataPointMap.values(), dp => this.#transformNumberDataPoint(dp, isJson)),
          aggregationTemporality: temporality,
          isMonotonic: metric.type === METRIC_TYPES.COUNTER || metric.type === METRIC_TYPES.OBSERVABLECOUNTER
        }
        break

      case METRIC_TYPES.GAUGE:
        result.gauge = {
          dataPoints: Array.from(metric.dataPointMap.values(), dp => this.#transformNumberDataPoint(dp, isJson))
        }
        break
    }

    return result
  }

  /**
   * Transforms a histogram data point.
   *
   * @param {HistogramDataPoint} dp - The histogram data point to transform
   * @param {boolean} isJson - Whether to output JSON format (vs protobuf)
   * @returns {Object} The histogram data point transformed to OTLP protobuf format
   */
  #transformHistogramDataPoint (dp, isJson) {
    const attributes = isJson
      ? this.attributesToJson(dp.attributes)
      : this.transformAttributes(dp.attributes)

    const dataPoint = {
      attributes,
      startTimeUnixNano: dp.startTimeUnixNano,
      timeUnixNano: dp.timeUnixNano,
      count: dp.count,
      sum: dp.sum,
      bucketCounts: dp.bucketCounts || [],
      explicitBounds: dp.explicitBounds || [],
      min: dp.min,
      max: dp.max
    }

    if (isJson) {
      dataPoint.startTimeUnixNano = String(dataPoint.startTimeUnixNano)
      dataPoint.timeUnixNano = String(dataPoint.timeUnixNano)
      dataPoint.count = dataPoint.count || 0
    }

    return dataPoint
  }

  /**
   * Transforms a number data point to protobuf or JSON format.
   *
   * @param {NumberDataPoint} dataPoint - The number data point to transform
   * @param {boolean} isJson - Whether to output JSON format (vs protobuf)
   * @returns {Object} The number data point transformed to OTLP protobuf format
   */
  #transformNumberDataPoint (dataPoint, isJson) {
    const attributes = isJson
      ? this.attributesToJson(dataPoint.attributes)
      : this.transformAttributes(dataPoint.attributes)
    const timeUnixNano = isJson
      ? String(dataPoint.timeUnixNano)
      : dataPoint.timeUnixNano

    const result = {
      attributes,
      timeUnixNano
    }

    if (dataPoint.startTimeUnixNano) {
      result.startTimeUnixNano = isJson ? String(dataPoint.startTimeUnixNano) : dataPoint.startTimeUnixNano
    }

    this.#assignNumberValue(result, dataPoint.value)
    return result
  }

  /**
   * Assigns the appropriate value field (asInt or asDouble) based on the value type.
   *
   * @param {NumberDataPoint} dataPoint - The number data point to assign a value to
   * @param {number} value - The value to assign
   * @returns {void}
   */
  #assignNumberValue (dataPoint, value) {
    if (Number.isInteger(value)) {
      dataPoint.asInt = value
    } else {
      dataPoint.asDouble = value
    }
  }
}

module.exports = OtlpTransformer
