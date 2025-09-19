'use strict'

/**
 * @fileoverview OTLP Transformer for OpenTelemetry logs
 *
 * VERSION SUPPORT:
 * - OTLP Protocol: v1.7.0
 * - Protobuf Definitions: v1.7.0 (vendored from opentelemetry-proto)
 * - Other versions are not supported
 *
 * NOTE: The official @opentelemetry/otlp-transformer package is tightly coupled to the
 * OpenTelemetry SDK and requires @opentelemetry/sdk-logs as a dependency. To avoid
 * pulling in the full SDK, we provide our own implementation that is heavily inspired
 * by the existing OpenTelemetry prior art.
 *
 * This implementation is based on:
 * - Official SDK Documentation: https://open-telemetry.github.io/opentelemetry-js/modules/_opentelemetry_sdk-logs.html
 * - OTLP Transformer: https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/opentelemetry-otlp-transformer
 * - OTLP Protocol Specification: https://opentelemetry.io/docs/specs/otlp/
 *
 * Reference implementation (heavily inspired by):
 * - https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/opentelemetry-otlp-transformer
 * - https://github.com/open-telemetry/opentelemetry-proto (v1.7.0)
 */

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
  constructor (config = {}) {
    this._config = config
    this._protocol = config.protocol || 'http/protobuf'
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
      attributes: this._transformAttributes(this._config.resource?.attributes || {}),
      droppedAttributesCount: 0
    }
  }

  _transformScope (instrumentationLibrary) {
    if (!instrumentationLibrary) {
      return {
        name: 'dd-trace-js',
        version: '1.0.0',
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
    // const { _severityNumber } = this._getProtobufTypes()

    return {
      timeUnixNano: logRecord.timestamp || Date.now() * 1_000_000,
      observedTimeUnixNano: logRecord.timestamp || Date.now() * 1_000_000,
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

    // Map OpenTelemetry API severity numbers to protobuf enum values
    const severityMap = {
      [SeverityNumber.TRACE]: _severityNumber.SEVERITY_NUMBER_TRACE,
      [SeverityNumber.TRACE2]: _severityNumber.SEVERITY_NUMBER_TRACE2,
      [SeverityNumber.TRACE3]: _severityNumber.SEVERITY_NUMBER_TRACE3,
      [SeverityNumber.TRACE4]: _severityNumber.SEVERITY_NUMBER_TRACE4,
      [SeverityNumber.DEBUG]: _severityNumber.SEVERITY_NUMBER_DEBUG,
      [SeverityNumber.DEBUG2]: _severityNumber.SEVERITY_NUMBER_DEBUG2,
      [SeverityNumber.DEBUG3]: _severityNumber.SEVERITY_NUMBER_DEBUG3,
      [SeverityNumber.DEBUG4]: _severityNumber.SEVERITY_NUMBER_DEBUG4,
      [SeverityNumber.INFO]: _severityNumber.SEVERITY_NUMBER_INFO,
      [SeverityNumber.INFO2]: _severityNumber.SEVERITY_NUMBER_INFO2,
      [SeverityNumber.INFO3]: _severityNumber.SEVERITY_NUMBER_INFO3,
      [SeverityNumber.INFO4]: _severityNumber.SEVERITY_NUMBER_INFO4,
      [SeverityNumber.WARN]: _severityNumber.SEVERITY_NUMBER_WARN,
      [SeverityNumber.WARN2]: _severityNumber.SEVERITY_NUMBER_WARN2,
      [SeverityNumber.WARN3]: _severityNumber.SEVERITY_NUMBER_WARN3,
      [SeverityNumber.WARN4]: _severityNumber.SEVERITY_NUMBER_WARN4,
      [SeverityNumber.ERROR]: _severityNumber.SEVERITY_NUMBER_ERROR,
      [SeverityNumber.ERROR2]: _severityNumber.SEVERITY_NUMBER_ERROR2,
      [SeverityNumber.ERROR3]: _severityNumber.SEVERITY_NUMBER_ERROR3,
      [SeverityNumber.ERROR4]: _severityNumber.SEVERITY_NUMBER_ERROR4,
      [SeverityNumber.FATAL]: _severityNumber.SEVERITY_NUMBER_FATAL,
      [SeverityNumber.FATAL2]: _severityNumber.SEVERITY_NUMBER_FATAL2,
      [SeverityNumber.FATAL3]: _severityNumber.SEVERITY_NUMBER_FATAL3,
      [SeverityNumber.FATAL4]: _severityNumber.SEVERITY_NUMBER_FATAL4
    }

    return severityMap[severityNumber] || _severityNumber.SEVERITY_NUMBER_INFO
  }

  _hexToBytes (hexString) {
    if (!hexString || hexString.length === 0) {
      return Buffer.alloc(0)
    }

    // Remove any '0x' prefix
    const cleanHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString

    // Ensure even length
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
