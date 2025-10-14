'use strict'

const log = require('../../log')

/**
 * @typedef {import('@opentelemetry/api').Attributes} Attributes
 */

/**
 * Base class for OTLP transformers.
 *
 * This implementation provides common functionality for transforming
 * data to OTLP format (protobuf or JSON).
 *
 * @class OtlpTransformerBase
 */
class OtlpTransformerBase {
  #resourceAttributes

  /**
   * Creates a new OtlpTransformerBase instance.
   *
   * @param {Attributes} resourceAttributes - Resource attributes
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {string} signalType - Signal type for warning messages (e.g., 'logs', 'metrics')
   */
  constructor (resourceAttributes, protocol, signalType) {
    this.#resourceAttributes = this._transformAttributes(resourceAttributes)
    if (protocol === 'grpc') {
      log.warn(`OTLP gRPC protocol is not supported for ${signalType}. ` +
        'Defaulting to http/protobuf. gRPC protobuf support may be added in a future release.')
      protocol = 'http/protobuf'
    }
    this.protocol = protocol
  }

  /**
   * Groups items by instrumentation scope (name, version, and schemaUrl).
   * @param {Array} items - Array of items to group
   * @returns {Map<string, Array>} Map of instrumentation scope key to items
   * @protected
   */
  _groupByInstrumentationScope (items) {
    const grouped = new Map()

    for (const item of items) {
      const instrumentationScope = item.instrumentationScope || { name: '', version: '', schemaUrl: '' }
      const key = `${instrumentationScope.name}@${instrumentationScope.version}@${instrumentationScope.schemaUrl}`

      const group = grouped.get(key)
      if (group === undefined) {
        grouped.set(key, [item])
      } else {
        group.push(item)
      }
    }
    return grouped
  }

  /**
   * Transforms resource attributes to OTLP resource format.
   * @returns {Object} OTLP resource object
   * @protected
   */
  _transformResource () {
    return {
      attributes: this.#resourceAttributes,
      droppedAttributesCount: 0
    }
  }

  /**
   * Transforms attributes to OTLP KeyValue format.
   * @param {Object} attributes - Attributes to transform
   * @returns {Object[]} Array of OTLP KeyValue objects
   * @protected
   */
  _transformAttributes (attributes) {
    if (!attributes) return []

    return Object.entries(attributes).map(([key, value]) => ({
      key,
      value: this._transformAnyValue(value)
    }))
  }

  /**
   * Transforms attributes to JSON format (simplified).
   * @param {Object} attributes - Attributes to transform
   * @returns {Object[]} Array of OTLP KeyValue objects with string values
   * @protected
   */
  _attributesToJson (attributes) {
    if (!attributes) return []

    return Object.entries(attributes).map(([key, value]) => ({
      key,
      value: { stringValue: String(value) }
    }))
  }

  /**
   * Transforms any value to OTLP AnyValue format.
   * @param {any} value - Value to transform
   * @returns {Object} OTLP AnyValue object
   * @protected
   */
  _transformAnyValue (value) {
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
          values: value.map(v => this._transformAnyValue(v))
        }
      }
    } else if (value && typeof value === 'object') {
      return {
        kvlistValue: {
          values: Object.entries(value).map(([k, v]) => ({
            key: k,
            value: this._transformAnyValue(v)
          }))
        }
      }
    }
    return { stringValue: String(value) }
  }

  /**
   * Serializes data to protobuf format.
   * @param {Object} protoType - Protobuf type from protobuf_loader
   * @param {Object} data - Data to serialize
   * @returns {Buffer} Protobuf-encoded data
   * @protected
   */
  _serializeToProtobuf (protoType, data) {
    const message = protoType.create(data)
    const buffer = protoType.encode(message).finish()
    return buffer
  }

  /**
   * Serializes data to JSON format.
   * @param {Object} data - Data to serialize
   * @returns {Buffer} JSON-encoded data
   * @protected
   */
  _serializeToJson (data) {
    return Buffer.from(JSON.stringify(data))
  }
}

module.exports = OtlpTransformerBase
