'use strict'

const OtlpTransformerBase = require('../otlp/otlp_transformer_base')
const { getProtobufTypes } = require('../otlp/protobuf_loader')
const { METRIC_TYPES, TEMPORALITY } = require('./constants')

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
   * @private
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
   * @param {Array} metrics - Array of metrics to transform
   * @param {boolean} isJson - Whether to format for JSON output
   * @returns {Object[]} Array of scope metric objects
   * @private
   */
  #transformScope (metrics, isJson = false) {
    const groupedMetrics = this.groupByInstrumentationScope(metrics)
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

      if (attributes) {
        const transformed = isJson ? this.attributesToJson(attributes) : this.transformAttributes(attributes)
        if (transformed.length) {
          scope.attributes = transformed
        }
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

    const temporality = metric.temporality === TEMPORALITY.CUMULATIVE
      ? AGGREGATION_TEMPORALITY_CUMULATIVE
      : AGGREGATION_TEMPORALITY_DELTA

    switch (metric.type) {
      case METRIC_TYPES.HISTOGRAM:
        result.histogram = {
          dataPoints: metric.data.map(dp => ({
            attributes: this.transformAttributes(dp.attributes),
            startTimeUnixNano: dp.startTimeUnixNano,
            timeUnixNano: dp.timeUnixNano,
            count: dp.count,
            sum: dp.sum,
            bucketCounts: dp.bucketCounts || [],
            explicitBounds: dp.explicitBounds || [],
            min: dp.min,
            max: dp.max
          })),
          aggregationTemporality: temporality
        }
        break

      case METRIC_TYPES.COUNTER:
      case METRIC_TYPES.OBSERVABLECOUNTER:
      case METRIC_TYPES.UPDOWNCOUNTER:
      case METRIC_TYPES.OBSERVABLEUPDOWNCOUNTER:
        result.sum = {
          dataPoints: metric.data.map(dp => this.#transformNumberDataPoint(dp)),
          aggregationTemporality: temporality,
          isMonotonic: metric.type === METRIC_TYPES.COUNTER || metric.type === METRIC_TYPES.OBSERVABLECOUNTER
        }
        break

      case METRIC_TYPES.GAUGE:
        result.gauge = {
          dataPoints: metric.data.map(dp => this.#transformNumberDataPoint(dp))
        }
        break
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

    const temporalityStr = metric.temporality === TEMPORALITY.CUMULATIVE
      ? 'AGGREGATION_TEMPORALITY_CUMULATIVE'
      : 'AGGREGATION_TEMPORALITY_DELTA'

    switch (metric.type) {
      case METRIC_TYPES.HISTOGRAM:
        result.histogram = {
          dataPoints: metric.data.map(dp => ({
            attributes: this.attributesToJson(dp.attributes),
            startTimeUnixNano: String(dp.startTimeUnixNano),
            timeUnixNano: String(dp.timeUnixNano),
            count: dp.count || 0,
            sum: dp.sum,
            bucketCounts: dp.bucketCounts || [],
            explicitBounds: dp.explicitBounds || [],
            min: dp.min,
            max: dp.max
          })),
          aggregationTemporality: temporalityStr,
        }
        break

      case METRIC_TYPES.COUNTER:
      case METRIC_TYPES.OBSERVABLECOUNTER:
      case METRIC_TYPES.UPDOWNCOUNTER:
      case METRIC_TYPES.OBSERVABLEUPDOWNCOUNTER:
        result.sum = {
          dataPoints: metric.data.map(dp => this.#numberDataPointToJson(dp)),
          aggregationTemporality: temporalityStr,
          isMonotonic: metric.type === METRIC_TYPES.COUNTER || metric.type === METRIC_TYPES.OBSERVABLECOUNTER
        }
        break

      case METRIC_TYPES.GAUGE:
        result.gauge = {
          dataPoints: metric.data.map(dp => this.#numberDataPointToJson(dp))
        }
        break
    }

    return result
  }

  /**
   * Transforms a number data point to protobuf format.
   * @private
   */
  #transformNumberDataPoint (dataPoint) {
    const result = {
      attributes: this.transformAttributes(dataPoint.attributes),
      timeUnixNano: dataPoint.timeUnixNano,
    }

    if (dataPoint.startTimeUnixNano) {
      result.startTimeUnixNano = dataPoint.startTimeUnixNano
    }

    this.#assignNumberValue(result, dataPoint.value)
    return result
  }

  /**
   * Transforms a number data point to JSON format.
   * @private
   */
  #numberDataPointToJson (dataPoint) {
    const result = {
      attributes: this.attributesToJson(dataPoint.attributes),
      timeUnixNano: String(dataPoint.timeUnixNano)
    }

    if (dataPoint.startTimeUnixNano) {
      result.startTimeUnixNano = String(dataPoint.startTimeUnixNano)
    }

    this.#assignNumberValue(result, dataPoint.value)
    return result
  }

  /**
   * Assigns the appropriate value field (asInt or asDouble) based on the value type.
   * @private
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
