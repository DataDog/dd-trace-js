'use strict'

const { getProtobufTypes } = require('../protos/protobuf_loader')

// Get the aggregation temporality enum
const { protoAggregationTemporality } = getProtobufTypes()
const AGGREGATION_TEMPORALITY_DELTA = protoAggregationTemporality.values.AGGREGATION_TEMPORALITY_DELTA

/**
 * @typedef {import('@opentelemetry/api').Attributes} Attributes
 */

/**
 * OtlpTransformer transforms metrics to OTLP format.
 *
 * This implementation follows the OTLP Metrics Data Model specification:
 * https://opentelemetry.io/docs/specs/otlp/#metrics-data-model
 *
 * @class OtlpTransformer
 */
class OtlpTransformer {
  #resourceAttributes

  /**
   * Creates a new OtlpTransformer instance.
   *
   * @param {Attributes} resourceAttributes - Resource attributes
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   */
  constructor (resourceAttributes, protocol) {
    this.#resourceAttributes = this.#transformAttributes(resourceAttributes)
    this.protocol = protocol
  }

  /**
   * Transforms metrics to OTLP format based on the configured protocol.
   * @param {Array} metrics - Array of metric data to transform
   * @returns {Buffer} Transformed metrics in the appropriate format
   */
  transformMetrics (metrics) {
    // Use the configured protocol to determine serialization format
    if (this.protocol === 'http/json') {
      return this.#transformToJson(metrics)
    }
    // Default to protobuf for http/protobuf or any other protocol
    return this.#transformToProtobuf(metrics)
  }

  /**
   * Groups metrics by instrumentation scope (name, version, and schemaUrl).
   * @param {Array} metrics - Array of metrics to group
   * @returns {Map<string, Array>} Map of instrumentation scope key to metrics
   * @private
   */
  #groupByInstrumentationScope (metrics) {
    const grouped = new Map()

    for (const metric of metrics) {
      const instrumentationScope = metric.instrumentationScope || { name: '', version: '', schemaUrl: '' }
      const key = `${instrumentationScope.name}@${instrumentationScope.version}@${instrumentationScope.schemaUrl}`

      const group = grouped.get(key)
      if (group === undefined) {
        grouped.set(key, [metric])
      } else {
        group.push(metric)
      }
    }
    return grouped
  }

  /**
   * Transforms metrics to protobuf format.
   * @param {Array} metrics - Array of metrics to transform
   * @returns {Buffer} Protobuf-encoded metrics
   * @private
   */
  #transformToProtobuf (metrics) {
    const { protoMetricsService } = getProtobufTypes()

    const groupedMetrics = this.#groupByInstrumentationScope(metrics)
    const scopeMetrics = []

    for (const [key, metricsInScope] of groupedMetrics) {
      const [name, version, schemaUrl] = key.split('@')

      scopeMetrics.push({
        scope: {
          name,
          version,
          droppedAttributesCount: 0
        },
        schemaUrl,
        metrics: metricsInScope.map(metric => this.#transformMetric(metric))
      })
    }

    const payload = {
      resourceMetrics: [{
        resource: {
          attributes: this.#resourceAttributes,
          droppedAttributesCount: 0
        },
        scopeMetrics,
        schemaUrl: ''
      }]
    }

    const errMsg = protoMetricsService.verify(payload)
    if (errMsg) {
      throw new Error(`Invalid metrics payload: ${errMsg}`)
    }

    const message = protoMetricsService.create(payload)
    return Buffer.from(protoMetricsService.encode(message).finish())
  }

  /**
   * Transforms metrics to JSON format.
   * @param {Array} metrics - Array of metrics to transform
   * @returns {Buffer} JSON-encoded metrics
   * @private
   */
  #transformToJson (metrics) {
    const groupedMetrics = this.#groupByInstrumentationScope(metrics)
    const scopeMetrics = []

    for (const [key, metricsInScope] of groupedMetrics) {
      const [name, version, schemaUrl] = key.split('@')

      scopeMetrics.push({
        scope: {
          name,
          version
        },
        schemaUrl,
        metrics: metricsInScope.map(metric => this.#transformMetricToJson(metric))
      })
    }

    const payload = {
      resourceMetrics: [{
        resource: {
          attributes: this.#resourceAttributes.map(attr => ({
            key: attr.key,
            value: { stringValue: attr.value.stringValue }
          }))
        },
        scopeMetrics
      }]
    }

    return Buffer.from(JSON.stringify(payload))
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

    if (metric.type === 'histogram') {
      result.histogram = {
        dataPoints: metric.data.map(dp => ({
          attributes: this.#transformAttributes(dp.attributes),
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
        aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA
      }
    } else if (metric.type === 'counter') {
      result.sum = {
        dataPoints: metric.data.map(dp => this.#transformNumberDataPoint(dp)),
        aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
        isMonotonic: true
      }
    } else if (metric.type === 'updowncounter') {
      result.sum = {
        dataPoints: metric.data.map(dp => this.#transformNumberDataPoint(dp)),
        aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
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

    if (metric.type === 'histogram') {
      result.histogram = {
        dataPoints: metric.data.map(dp => ({
          attributes: this.#attributesToJson(dp.attributes),
          startTimeUnixNano: String(dp.startTimeUnixNano),
          timeUnixNano: String(dp.timeUnixNano),
          count: String(dp.count),
          sum: dp.sum,
          bucketCounts: dp.bucketCounts?.map(String) || [],
          explicitBounds: dp.explicitBounds || [],
          min: dp.min,
          max: dp.max
        })),
        aggregationTemporality: 'AGGREGATION_TEMPORALITY_DELTA'
      }
    } else if (metric.type === 'counter') {
      result.sum = {
        dataPoints: metric.data.map(dp => this.#numberDataPointToJson(dp)),
        aggregationTemporality: 'AGGREGATION_TEMPORALITY_DELTA',
        isMonotonic: true
      }
    } else if (metric.type === 'updowncounter') {
      result.sum = {
        dataPoints: metric.data.map(dp => this.#numberDataPointToJson(dp)),
        aggregationTemporality: 'AGGREGATION_TEMPORALITY_DELTA',
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
      attributes: this.#transformAttributes(dataPoint.attributes),
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
      attributes: this.#attributesToJson(dataPoint.attributes),
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

  /**
   * Transforms attributes to protobuf format.
   * @private
   */
  #transformAttributes (attributes) {
    if (!attributes) return []

    return Object.entries(attributes).map(([key, value]) => ({
      key,
      value: this.#transformAttributeValue(value)
    }))
  }

  /**
   * Transforms attributes to JSON format.
   * @private
   */
  #attributesToJson (attributes) {
    if (!attributes) return []

    return Object.entries(attributes).map(([key, value]) => ({
      key,
      value: { stringValue: String(value) }
    }))
  }

  /**
   * Transforms an attribute value to the appropriate protobuf type.
   * @private
   */
  #transformAttributeValue (value) {
    if (typeof value === 'string') {
      return { stringValue: value }
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        return { intValue: value }
      }
      return { doubleValue: value }
    } else if (typeof value === 'boolean') {
      return { boolValue: value }
    } else if (Array.isArray(value)) {
      return {
        arrayValue: {
          values: value.map(v => this.#transformAttributeValue(v))
        }
      }
    }
    return { stringValue: String(value) }
  }
}

module.exports = OtlpTransformer
