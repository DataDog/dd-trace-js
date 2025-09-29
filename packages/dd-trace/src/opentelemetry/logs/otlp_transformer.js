'use strict'

const { SeverityNumber } = require('@opentelemetry/api-logs')
const { loadProtobufDefinitions } = require('./protobuf_loader')

/**
 * @typedef {import('@opentelemetry/api').Attributes} Attributes
*/

// Global severity mapping constant - no need to regenerate
const SEVERITY_MAP = {
  [SeverityNumber.TRACE]: 'SEVERITY_NUMBER_TRACE',
  [SeverityNumber.TRACE2]: 'SEVERITY_NUMBER_TRACE2',
  [SeverityNumber.TRACE3]: 'SEVERITY_NUMBER_TRACE3',
  [SeverityNumber.TRACE4]: 'SEVERITY_NUMBER_TRACE4',
  [SeverityNumber.DEBUG]: 'SEVERITY_NUMBER_DEBUG',
  [SeverityNumber.DEBUG2]: 'SEVERITY_NUMBER_DEBUG2',
  [SeverityNumber.DEBUG3]: 'SEVERITY_NUMBER_DEBUG3',
  [SeverityNumber.DEBUG4]: 'SEVERITY_NUMBER_DEBUG4',
  [SeverityNumber.INFO]: 'SEVERITY_NUMBER_INFO',
  [SeverityNumber.INFO2]: 'SEVERITY_NUMBER_INFO2',
  [SeverityNumber.INFO3]: 'SEVERITY_NUMBER_INFO3',
  [SeverityNumber.INFO4]: 'SEVERITY_NUMBER_INFO4',
  [SeverityNumber.WARN]: 'SEVERITY_NUMBER_WARN',
  [SeverityNumber.WARN2]: 'SEVERITY_NUMBER_WARN2',
  [SeverityNumber.WARN3]: 'SEVERITY_NUMBER_WARN3',
  [SeverityNumber.WARN4]: 'SEVERITY_NUMBER_WARN4',
  [SeverityNumber.ERROR]: 'SEVERITY_NUMBER_ERROR',
  [SeverityNumber.ERROR2]: 'SEVERITY_NUMBER_ERROR2',
  [SeverityNumber.ERROR3]: 'SEVERITY_NUMBER_ERROR3',
  [SeverityNumber.ERROR4]: 'SEVERITY_NUMBER_ERROR4',
  [SeverityNumber.FATAL]: 'SEVERITY_NUMBER_FATAL',
  [SeverityNumber.FATAL2]: 'SEVERITY_NUMBER_FATAL2',
  [SeverityNumber.FATAL3]: 'SEVERITY_NUMBER_FATAL3',
  [SeverityNumber.FATAL4]: 'SEVERITY_NUMBER_FATAL4'
}
const log = require('../../log')

/**
 * OtlpTransformer transforms log records to OTLP format.
 *
 * This implementation follows the OTLP Logs Data Model specification:
 * https://opentelemetry.io/docs/specs/otlp/#log-data-model
 *
 * @class OtlpTransformer
 */
class OtlpTransformer {
  #protobufTypes
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
    this.#protobufTypes = null
  }

  /**
   * Transforms log records to OTLP format based on the configured protocol.
   * @param {Object[]} logRecords - Array of enriched log records to transform
   * @returns {Buffer} Transformed log records in the appropriate format
   */
  transformLogRecords (logRecords) {
    // Use the configured protocol to determine serialization format
    if (this.protocol === 'http/json') {
      return this.#transformToJson(logRecords)
    }
    // Default to protobuf for http/protobuf or any other protocol
    return this.#transformToProtobuf(logRecords)
  }

  /**
   * Groups log records by instrumentation library (name and version).
   * @param {Object[]} logRecords - Array of log records to group
   * @returns {Map<string, Object[]>} Map of instrumentation library key to log records
   * @private
   */
  #groupByInstrumentationLibrary (logRecords) {
    const grouped = new Map()

    for (const record of logRecords) {
      const instrumentationLibrary = record.instrumentationLibrary || { name: '', version: '0.0.0' }
      const key = `${instrumentationLibrary.name}@${instrumentationLibrary.version}`

      const group = grouped.get(key)
      if (group === undefined) {
        grouped.set(key, [record])
      } else {
        group.push(record)
      }
    }
    return grouped
  }

  /**
   * Gets the protobuf types, loading them lazily to reduce startup overhead.
   * @returns {Object} Protobuf types object
   * @private
   */
  #getProtobufTypes () {
    // Delay the loading of protobuf types to reduce startup overhead
    if (!this.#protobufTypes) {
      this.#protobufTypes = loadProtobufDefinitions()
    }
    return this.#protobufTypes
  }

  /**
   * Transforms log records to protobuf format.
   * @param {Object[]} logRecords - Array of enriched log records to transform
   * @returns {Buffer} Protobuf-encoded log records
   * @private
   */
  #transformToProtobuf (logRecords) {
    const { _logsService } = this.#getProtobufTypes()
    // Create the OTLP LogsData structure
    const logsData = {
      resourceLogs: [{
        resource: this.#transformResource(),
        scopeLogs: this.#transformScope(logRecords),
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
  #transformToJson (logRecords) {
    const logsData = {
      resourceLogs: [{
        resource: this.#transformResource(),
        scopeLogs: this.#transformScope(logRecords)
      }]
    }
    return Buffer.from(JSON.stringify(logsData))
  }

  /**
   * Creates scope logs grouped by instrumentation library.
   * @param {Object[]} logRecords - Array of log records to transform
   * @returns {Object[]} Array of scope log objects
   * @private
   */
  #transformScope (logRecords) {
    // Group log records by instrumentation library
    const groupedRecords = this.#groupByInstrumentationLibrary(logRecords)

    // Create scope logs for each instrumentation library
    const scopeLogs = []

    for (const [, records] of groupedRecords.entries()) {
      scopeLogs.push({
        scope: {
          name: records[0]?.instrumentationLibrary?.name || 'dd-trace-js',
          version: records[0]?.instrumentationLibrary?.version || '',
          // TODO: Support setting attributes on instrumentation library
          attributes: [],
          droppedAttributesCount: 0
        },
        logRecords: records.map(record => this.#transformLogRecord(record))
      })
    }

    return scopeLogs
  }

  /**
   * Transforms resource attributes to OTLP resource format.
   * @returns {Object} OTLP resource object
   * @private
   */
  #transformResource () {
    return {
      attributes: this.#resourceAttributes,
      droppedAttributesCount: 0
    }
  }

  /**
   * Transforms a single log record to OTLP format.
   * @param {Object} logRecord - Log record to transform
   * @returns {Object} OTLP log record object
   * @private
   */
  #transformLogRecord (logRecord) {
    const timestamp = logRecord.timestamp || Date.now() * 1_000_000

    return {
      timeUnixNano: timestamp,
      observedTimeUnixNano: timestamp,
      severityNumber: this.#mapSeverityNumber(logRecord.severityNumber || SeverityNumber.INFO),
      severityText: logRecord.severityText || 'INFO',
      body: this.#transformBody(logRecord.body),
      attributes: this.#transformAttributes(logRecord.attributes),
      droppedAttributesCount: 0,
      flags: logRecord.flags || 0,
      traceId: this.#hexToBytes(logRecord.traceId || ''),
      spanId: this.#hexToBytes(logRecord.spanId || '')
    }
  }

  /**
   * Maps OpenTelemetry severity number to protobuf severity number.
   * @param {number} severityNumber - OpenTelemetry severity number
   * @returns {number} Protobuf severity number
   * @private
   */
  #mapSeverityNumber (severityNumber) {
    const { _severityNumber } = this.#getProtobufTypes()

    if (!_severityNumber) {
      log.error('_severityNumber is undefined')
      return 9 // Default to INFO
    }

    const severityName = SEVERITY_MAP[severityNumber] || 'SEVERITY_NUMBER_INFO'
    return _severityNumber.values[severityName]
  }

  /**
   * Converts a hex string to a Buffer.
   * @param {string} hexString - Hex string to convert
   * @returns {Buffer} Buffer containing the hex data
   * @private
   */
  #hexToBytes (hexString) {
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
  #transformBody (body) {
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
            value: this.#transformAnyValue(value)
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
  #transformAttributes (attributes) {
    if (!attributes) {
      return {}
    }
    return Object.entries(attributes).map(([key, value]) => ({
      key,
      value: this.#transformAnyValue(value)
    }))
  }

  /**
   * Transforms any value to OTLP AnyValue format.
   * @param {any} value - Value to transform
   * @returns {Object} OTLP AnyValue object
   * @private
   */
  #transformAnyValue (value) {
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
          values: value.map(v => this.#transformAnyValue(v))
        }
      }
    } else if (value && typeof value === 'object') {
      return {
        kvlistValue: {
          values: Object.entries(value).map(([k, v]) => ({
            key: k,
            value: this.#transformAnyValue(v)
          }))
        }
      }
    }
    return { stringValue: String(value) }
  }
}

module.exports = OtlpTransformer
