'use strict'

const { SeverityNumber } = require('@opentelemetry/api-logs')
const { getProtobufTypes } = require('./protobuf_loader')

/**
 * OtlpTransformer transforms log records to OTLP format.
 *
 * This implementation follows the OTLP Logs Data Model specification:
 * https://opentelemetry.io/docs/specs/otlp/#log-data-model
 *
 * @class OtlpTransformer
 */
class OtlpTransformer {
  /**
   * Creates a new OtlpTransformer instance.
   *
   * @param {Object} resourceAttributes - Resource attributes
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   */
  constructor (resourceAttributes, protocol) {
    this._resourceAttributes = this._transformAttributes(resourceAttributes)
    this.protocol = protocol
    this._protobufTypes = null
  }

  /**
   * Gets the protobuf types, loading them lazily to reduce startup overhead.
   * @returns {Object} Protobuf types object
   * @private
   */
  _getProtobufTypes () {
    // Delay the loading of protobuf types to reduce startup overhead
    if (!this._protobufTypes) {
      this._protobufTypes = getProtobufTypes()
    }
    return this._protobufTypes
  }

  /**
   * Transforms log records to OTLP format based on the configured protocol.
   * @param {Object[]} logRecords - Array of enriched log records to transform
   * @returns {Buffer} Transformed log records in the appropriate format
   */
  transformLogRecords (logRecords) {
    // Use the configured protocol to determine serialization format
    if (this.protocol === 'http/json') {
      return this._transformToJson(logRecords)
    }
    // Default to protobuf for http/protobuf or any other protocol
    return this._transformToProtobuf(logRecords)
  }

  /**
   * Transforms log records to protobuf format.
   * @param {Object[]} logRecords - Array of enriched log records to transform
   * @returns {Buffer} Protobuf-encoded log records
   * @private
   */
  _transformToProtobuf (logRecords) {
    const { _logsService } = this._getProtobufTypes()

    // Create the OTLP LogsData structure
    const logsData = {
      resourceLogs: [{
        resource: this._transformResource(),
        scopeLogs: [{
          scope: this._transformScope(logRecords[0]?.instrumentationLibrary),
          logRecords: logRecords.map(record => this._transformLogRecord(record))
        }]
      }]
    }

    // Serialize to protobuf
    const message = _logsService.create(logsData)
    const buffer = _logsService.encode(message).finish()

    return buffer
  }

  /**
   * Transforms log records to JSON format.
   * @param {Object[]} logRecords - Array of enriched log records to transform
   * @returns {Buffer} JSON-encoded log records
   * @private
   */
  _transformToJson (logRecords) {
    // JSON transformation for http/json protocol
    const logsData = {
      resourceLogs: [{
        resource: this._transformResource(),
        scopeLogs: [{
          scope: this._transformScope(logRecords[0]?.instrumentationLibrary),
          logRecords: logRecords.map(record => this._transformLogRecord(record))
        }]
      }]
    }
    return Buffer.from(JSON.stringify(logsData))
  }

  /**
   * Transforms instrumentation library information to OTLP scope format.
   * @param {Object} instrumentationLibrary - Instrumentation library info
   * @returns {Object} OTLP scope object
   * @private
   */
  _transformScope (instrumentationLibrary) {
    return {
      name: instrumentationLibrary?.name || 'dd-trace-js',
      version: instrumentationLibrary?.version || '',
      attributes: [],
      droppedAttributesCount: 0
    }
  }

  /**
   * Transforms resource attributes to OTLP resource format.
   * @returns {Object} OTLP resource object
   * @private
   */
  _transformResource () {
    return {
      attributes: this._resourceAttributes,
      droppedAttributesCount: 0
    }
  }

  /**
   * Transforms a single log record to OTLP format.
   * @param {Object} logRecord - Log record to transform
   * @returns {Object} OTLP log record object
   * @private
   */
  _transformLogRecord (logRecord) {
    const timestamp = logRecord.timestamp || Date.now() * 1_000_000

    return {
      timeUnixNano: timestamp,
      observedTimeUnixNano: timestamp,
      severityNumber: this._mapSeverityNumber(logRecord.severityNumber || SeverityNumber.INFO),
      severityText: logRecord.severityText || 'INFO',
      body: this._transformBody(logRecord.body),
      attributes: this._transformAttributes(logRecord.attributes),
      droppedAttributesCount: 0,
      flags: logRecord.flags || 0,
      traceId: this._hexToBytes(logRecord.traceId || ''),
      spanId: this._hexToBytes(logRecord.spanId || '')
    }
  }

  /**
   * Maps OpenTelemetry severity number to protobuf severity number.
   * @param {number} severityNumber - OpenTelemetry severity number
   * @returns {number} Protobuf severity number
   * @private
   */
  _mapSeverityNumber (severityNumber) {
    const { _severityNumber } = this._getProtobufTypes()

    if (!_severityNumber) {
      // eslint-disable-next-line no-console
      console.error('_severityNumber is undefined')
      return 9 // Default to INFO
    }

    const severityMap = this._createSeverityMap(_severityNumber)
    return severityMap[severityNumber] || _severityNumber.values.SEVERITY_NUMBER_INFO
  }

  /**
   * Creates a mapping from OpenTelemetry severity numbers to protobuf severity numbers.
   * @param {Object} severityEnum - Protobuf severity enum
   * @returns {Object} Severity mapping object
   * @private
   */
  _createSeverityMap (severityEnum) {
    const map = {}
    map[SeverityNumber.TRACE] = severityEnum.values.SEVERITY_NUMBER_TRACE
    map[SeverityNumber.TRACE2] = severityEnum.values.SEVERITY_NUMBER_TRACE2
    map[SeverityNumber.TRACE3] = severityEnum.values.SEVERITY_NUMBER_TRACE3
    map[SeverityNumber.TRACE4] = severityEnum.values.SEVERITY_NUMBER_TRACE4
    map[SeverityNumber.DEBUG] = severityEnum.values.SEVERITY_NUMBER_DEBUG
    map[SeverityNumber.DEBUG2] = severityEnum.values.SEVERITY_NUMBER_DEBUG2
    map[SeverityNumber.DEBUG3] = severityEnum.values.SEVERITY_NUMBER_DEBUG3
    map[SeverityNumber.DEBUG4] = severityEnum.values.SEVERITY_NUMBER_DEBUG4
    map[SeverityNumber.INFO] = severityEnum.values.SEVERITY_NUMBER_INFO
    map[SeverityNumber.INFO2] = severityEnum.values.SEVERITY_NUMBER_INFO2
    map[SeverityNumber.INFO3] = severityEnum.values.SEVERITY_NUMBER_INFO3
    map[SeverityNumber.INFO4] = severityEnum.values.SEVERITY_NUMBER_INFO4
    map[SeverityNumber.WARN] = severityEnum.values.SEVERITY_NUMBER_WARN
    map[SeverityNumber.WARN2] = severityEnum.values.SEVERITY_NUMBER_WARN2
    map[SeverityNumber.WARN3] = severityEnum.values.SEVERITY_NUMBER_WARN3
    map[SeverityNumber.WARN4] = severityEnum.values.SEVERITY_NUMBER_WARN4
    map[SeverityNumber.ERROR] = severityEnum.values.SEVERITY_NUMBER_ERROR
    map[SeverityNumber.ERROR2] = severityEnum.values.SEVERITY_NUMBER_ERROR2
    map[SeverityNumber.ERROR3] = severityEnum.values.SEVERITY_NUMBER_ERROR3
    map[SeverityNumber.ERROR4] = severityEnum.values.SEVERITY_NUMBER_ERROR4
    map[SeverityNumber.FATAL] = severityEnum.values.SEVERITY_NUMBER_FATAL
    map[SeverityNumber.FATAL2] = severityEnum.values.SEVERITY_NUMBER_FATAL2
    map[SeverityNumber.FATAL3] = severityEnum.values.SEVERITY_NUMBER_FATAL3
    map[SeverityNumber.FATAL4] = severityEnum.values.SEVERITY_NUMBER_FATAL4
    return map
  }

  /**
   * Converts a hex string to a Buffer.
   * @param {string} hexString - Hex string to convert
   * @returns {Buffer} Buffer containing the hex data
   * @private
   */
  _hexToBytes (hexString) {
    if (!hexString || hexString.length === 0) {
      return Buffer.alloc(0)
    }

    const cleanHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString
    const paddedHex = cleanHex.length % 2 === 0 ? cleanHex : '0' + cleanHex

    return Buffer.from(paddedHex, 'hex')
  }

  /**
   * Transforms log body to OTLP AnyValue format.
   * @param {any} body - Log body to transform
   * @returns {Object} OTLP AnyValue object
   * @private
   */
  _transformBody (body) {
    if (typeof body === 'string') {
      return {
        stringValue: body
      }
    } else if (typeof body === 'number') {
      return {
        intValue: body
      }
    } else if (typeof body === 'boolean') {
      return {
        boolValue: body
      }
    } else if (body && typeof body === 'object') {
      return {
        kvlistValue: {
          values: Object.entries(body).map(([key, value]) => ({
            key,
            value: this._transformAnyValue(value)
          }))
        }
      }
    }
    return {
      stringValue: String(body)
    }
  }

  /**
   * Transforms attributes to OTLP KeyValue format.
   * @param {Object} attributes - Attributes to transform
   * @returns {Object[]} Array of OTLP KeyValue objects
   * @private
   */
  _transformAttributes (attributes) {
    if (!attributes) {
      return {}
    }
    return Object.entries(attributes).map(([key, value]) => ({
      key,
      value: this._transformAnyValue(value)
    }))
  }

  /**
   * Transforms any value to OTLP AnyValue format.
   * @param {any} value - Value to transform
   * @returns {Object} OTLP AnyValue object
   * @private
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
}

module.exports = OtlpTransformer
