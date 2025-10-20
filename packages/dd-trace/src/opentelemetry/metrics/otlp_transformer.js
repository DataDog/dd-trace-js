'use strict'

const OtlpTransformerBase = require('../otlp/otlp_transformer_base')
const { getProtobufTypes } = require('../otlp/protobuf_loader')

// Get the aggregation temporality enum
const { protoAggregationTemporality } = getProtobufTypes()
const AGGREGATION_TEMPORALITY_DELTA = protoAggregationTemporality.values.AGGREGATION_TEMPORALITY_DELTA
const AGGREGATION_TEMPORALITY_CUMULATIVE = protoAggregationTemporality.values.AGGREGATION_TEMPORALITY_CUMULATIVE

/**
 * OtlpTransformer transforms metrics to OTLP format.
 *
 * This implementation follows the OTLP Metrics v1.7.0 Data Model specification:
 * https://opentelemetry.io/docs/specs/otlp/#metrics-data-model
 *
 * @class OtlpTransformer
 * @extends OtlpTransformerBase
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
   * @param {Array} metrics - Array of metric data to transform
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
   * @param {Array} metrics - Array of metrics to transform
   * @returns {Buffer} Protobuf-encoded metrics
   * @private
   */
  #transformToProtobuf (metrics) {
    const { protoMetricsService } = getProtobufTypes()

    const metricsData = {
      resourceMetrics: [{
        resource: this._transformResource(),
        scopeMetrics: this.#transformScope(metrics),
        schemaUrl: ''
      }]
    }

    return this._serializeToProtobuf(protoMetricsService, metricsData)
  }

  /**
   * Transforms metrics to JSON format.
   * @param {Array} metrics - Array of metrics to transform
   * @returns {Buffer} JSON-encoded metrics
   * @private
   */
  #transformToJson (metrics) {
    const metricsData = {
      resourceMetrics: [{
        resource: this._transformResource(),
        scopeMetrics: this.#transformScope(metrics, true)
      }]
    }
    return this._serializeToJson(metricsData)
  }

  /**
   * Creates scope metrics grouped by instrumentation scope.
   * @param {Array} metrics - Array of metrics to transform
   * @param {boolean} isJson - Whether to format for JSON output
   * @returns {Object[]} Array of scope metric objects
   * @private
   */
  #transformScope (metrics, isJson = false) {
    const groupedMetrics = this._groupByInstrumentationScope(metrics)
    const scopeMetrics = []

    for (const [, metricsInScope] of groupedMetrics) {
      // Get the first metric to extract the instrumentation scope details
      const firstMetric = metricsInScope[0]
      const instrumentationScope = firstMetric.instrumentationScope || {}
      const { name = '', version = '', schemaUrl = '', attributes = {} } = instrumentationScope

      const scope = {
        name,
        version,
        droppedAttributesCount: 0
      }

      // Add attributes if present
      if (attributes && Object.keys(attributes).length > 0) {
        scope.attributes = isJson ? this._attributesToJson(attributes) : this._transformAttributes(attributes)
      }

      scopeMetrics.push({
        scope,
        schemaUrl,
        metrics: metricsInScope.map(metric =>
          isJson ? this.#transformMetricToJson(metric) : this.#transformMetric(metric)
        )
      })
    }

    return scopeMetrics
  }

  /**
   * Transforms a single metric to protobuf format.
   * @private
   */
  #transformMetric (metric) {
    const result = {
      name: metric.name,
      description: metric.description || '',
      unit: metric.unit || ''
    }

    // Determine aggregation temporality
    const temporality = metric.temporality === 'CUMULATIVE'
      ? AGGREGATION_TEMPORALITY_CUMULATIVE
      : AGGREGATION_TEMPORALITY_DELTA

    if (metric.type === 'histogram') {
      result.histogram = {
        dataPoints: metric.data.map(dp => ({
          attributes: this._transformAttributes(dp.attributes),
          startTimeUnixNano: dp.startTimeUnixNano,
          timeUnixNano: dp.timeUnixNano,
          count: dp.count,
          sum: dp.sum,
          bucketCounts: dp.bucketCounts || [],
          explicitBounds: dp.explicitBounds || [],
          exemplars: [],
          flags: 0,
          min: dp.min,
          max: dp.max
        })),
        aggregationTemporality: temporality
      }
    } else if (metric.type === 'counter' || metric.type === 'observable-counter') {
      result.sum = {
        dataPoints: metric.data.map(dp => this.#transformNumberDataPoint(dp)),
        aggregationTemporality: temporality,
        isMonotonic: true
      }
    } else if (metric.type === 'updowncounter' || metric.type === 'observable-updowncounter') {
      result.sum = {
        dataPoints: metric.data.map(dp => this.#transformNumberDataPoint(dp)),
        aggregationTemporality: temporality,
        isMonotonic: false
      }
    } else if (metric.type === 'gauge') {
      result.gauge = {
        dataPoints: metric.data.map(dp => this.#transformNumberDataPoint(dp))
      }
    }

    return result
  }

  /**
   * Transforms a single metric to JSON format.
   * @private
   */
  #transformMetricToJson (metric) {
    const result = {
      name: metric.name,
      description: metric.description || '',
      unit: metric.unit || ''
    }

    // Determine aggregation temporality for JSON
    const temporalityStr = metric.temporality === 'CUMULATIVE'
      ? 'AGGREGATION_TEMPORALITY_CUMULATIVE'
      : 'AGGREGATION_TEMPORALITY_DELTA'

    if (metric.type === 'histogram') {
      result.histogram = {
        dataPoints: metric.data.map(dp => ({
          attributes: this._attributesToJson(dp.attributes),
          startTimeUnixNano: String(dp.startTimeUnixNano),
          timeUnixNano: String(dp.timeUnixNano),
          count: String(dp.count),
          sum: dp.sum,
          bucketCounts: dp.bucketCounts?.map(String) || [],
          explicitBounds: dp.explicitBounds || [],
          min: dp.min,
          max: dp.max
        })),
        aggregationTemporality: temporalityStr
      }
    } else if (metric.type === 'counter' || metric.type === 'observable-counter') {
      result.sum = {
        dataPoints: metric.data.map(dp => this.#numberDataPointToJson(dp)),
        aggregationTemporality: temporalityStr,
        isMonotonic: true
      }
    } else if (metric.type === 'updowncounter' || metric.type === 'observable-updowncounter') {
      result.sum = {
        dataPoints: metric.data.map(dp => this.#numberDataPointToJson(dp)),
        aggregationTemporality: temporalityStr,
        isMonotonic: false
      }
    } else if (metric.type === 'gauge') {
      result.gauge = {
        dataPoints: metric.data.map(dp => this.#numberDataPointToJson(dp))
      }
    }

    return result
  }

  /**
   * Transforms a number data point to protobuf format.
   * @private
   */
  #transformNumberDataPoint (dataPoint) {
    const result = {
      attributes: this._transformAttributes(dataPoint.attributes),
      timeUnixNano: dataPoint.timeUnixNano,
      exemplars: [],
      flags: 0
    }

    if (dataPoint.startTimeUnixNano) {
      result.startTimeUnixNano = dataPoint.startTimeUnixNano
    }

    // Determine if value is int or double
    if (Number.isInteger(dataPoint.value)) {
      result.asInt = dataPoint.value
    } else {
      result.asDouble = dataPoint.value
    }

    return result
  }

  /**
   * Transforms a number data point to JSON format.
   * @private
   */
  #numberDataPointToJson (dataPoint) {
    const result = {
      attributes: this._attributesToJson(dataPoint.attributes),
      timeUnixNano: String(dataPoint.timeUnixNano)
    }

    if (dataPoint.startTimeUnixNano) {
      result.startTimeUnixNano = String(dataPoint.startTimeUnixNano)
    }

    // Determine if value is int or double
    if (Number.isInteger(dataPoint.value)) {
      result.asInt = String(dataPoint.value)
    } else {
      result.asDouble = dataPoint.value
    }

    return result
  }
}

module.exports = OtlpTransformer
