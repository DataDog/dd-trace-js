'use strict'

const { SeverityNumber } = require('@opentelemetry/api-logs')
const { getProtobufTypes } = require('./protobuf_loader')
const tracerVersion = require('../../../../../package.json').version

/**
 * OtlpTransformer transforms log records to OTLP format.
 *
 * This implementation follows the OTLP Logs Data Model specification:
 * https://opentelemetry.io/docs/specs/otlp/#log-data-model
 *
 * @class OtlpTransformer
 */
class OtlpTransformer {
  constructor (config = {}) {
    this._resource = config.resource
    this._protocol = config.protocol
    this._protobufTypes = null
  }

  _getProtobufTypes () {
    if (!this._protobufTypes) {
      this._protobufTypes = getProtobufTypes()
    }
    return this._protobufTypes
  }

  transformLogRecords (logRecords) {
    // Use the configured protocol to determine serialization format
    if (this._protocol === 'http/json') {
      return this._transformToJson(logRecords)
    }
    // Default to protobuf for http/protobuf or any other protocol
    return this._transformToProtobuf(logRecords)
  }

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

  _transformResource () {
    return {
      attributes: this._transformAttributes(this._resource?.attributes || {}),
      droppedAttributesCount: 0
    }
  }

  _transformScope (instrumentationLibrary) {
    if (!instrumentationLibrary) {
      return {
        name: 'dd-trace-js',
        version: tracerVersion,
        attributes: [],
        droppedAttributesCount: 0
      }
    }

    return {
      name: instrumentationLibrary.name || 'dd-trace-js',
      version: instrumentationLibrary.version || '1.0.0',
      attributes: [],
      droppedAttributesCount: 0
    }
  }

  _transformLogRecord (logRecord) {
    const timestamp = logRecord.timestamp || Date.now() * 1_000_000

    return {
      timeUnixNano: timestamp,
      observedTimeUnixNano: timestamp,
      severityNumber: this._mapSeverityNumber(logRecord.severityNumber || SeverityNumber.INFO),
      severityText: logRecord.severityText || 'INFO',
      body: this._transformBody(logRecord.body),
      attributes: this._transformAttributes(logRecord.attributes || {}),
      droppedAttributesCount: 0,
      flags: logRecord.flags || 0,
      traceId: this._hexToBytes(logRecord.traceId || ''),
      spanId: this._hexToBytes(logRecord.spanId || '')
    }
  }

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

  _hexToBytes (hexString) {
    if (!hexString || hexString.length === 0) {
      return Buffer.alloc(0)
    }

    const cleanHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString
    const paddedHex = cleanHex.length % 2 === 0 ? cleanHex : '0' + cleanHex

    return Buffer.from(paddedHex, 'hex')
  }

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

  _transformAttributes (attributes) {
    return Object.entries(attributes).map(([key, value]) => ({
      key,
      value: this._transformAnyValue(value)
    }))
  }

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
