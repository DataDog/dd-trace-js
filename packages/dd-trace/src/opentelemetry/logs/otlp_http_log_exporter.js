'use strict'

const https = require('https')
const http = require('http')
const { URL } = require('url')
const log = require('../../log')
const OtlpTransformer = require('./otlp_transformer')
const telemetryMetrics = require('../../telemetry/metrics')

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

/**
 * OtlpHttpLogExporter exports log records via OTLP over HTTP.
 *
 * This implementation follows the OTLP HTTP specification:
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *
 * @class OtlpHttpLogExporter
 */
class OtlpHttpLogExporter {
  /**
   * Creates a new OtlpHttpLogExporter instance.
   *
   * @param {string} url - OTLP endpoint URL
   * @param {string} headers - Additional HTTP headers as comma-separated key=value string
   * @param {number} timeout - Request timeout in milliseconds
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {Object} resource - Resource attributes
   */
  constructor (url, headers, timeout, protocol, resource) {
    this._url = url
    this._protocol = protocol

    // Set Content-Type based on protocol
    const contentType = this._protocol === 'http/json'
      ? 'application/json'
      : 'application/x-protobuf'

    this._headers = {
      'Content-Type': contentType,
      ...this._parseAdditionalHeaders(headers)
    }
    this._timeout = timeout
    this._transformer = new OtlpTransformer(resource, protocol)

    // Pre-compute telemetry tags for efficiency
    this._telemetryTags = [
      `protocol:${this._protocol.startsWith('grpc') ? 'grpc' : 'http'}`,
      `encoding:${this._protocol === 'http/json' ? 'json' : 'protobuf'}`
    ]
  }

  /**
   * Exports log records via OTLP over HTTP.
   *
   * @param {Object[]} logRecords - Array of enriched log records to export
   * @param {Function} resultCallback - Callback function for export result
   */
  export (logRecords, resultCallback) {
    if (logRecords.length === 0) {
      resultCallback({ code: 0 })
      return
    }

    try {
      const payload = this._transformer.transformLogRecords(logRecords)

      // Track telemetry metric for OTLP log records
      try {
        tracerMetrics.count('otel.log_records', this._telemetryTags)
          .inc(logRecords.length)
      } catch (telemetryError) {
        log.debug('Error tracking OTLP log records telemetry:', telemetryError)
      }

      this._sendPayload(payload, resultCallback)
    } catch (error) {
      log.error('Error transforming log records:', error)
      resultCallback({ code: 1, error })
    }
  }

  /**
   * Parses additional HTTP headers from a comma-separated string.
   * @param {string} headersString - Comma-separated key=value pairs
   * @returns {Record<string, string>} Parsed headers object
   * @private
   */
  _parseAdditionalHeaders (headersString) {
    if (!headersString || typeof headersString !== 'string') {
      return {}
    }

    return Object.fromEntries(
      headersString
        .split(',')
        .map(pair => pair.trim().split('='))
        .filter(([key, value]) => key && value)
        .map(([key, value]) => [key.trim(), value.trim()])
    )
  }

  /**
   * Sends the payload via HTTP request.
   * @param {Buffer|string} payload - The payload to send
   * @param {Function} resultCallback - Callback for the result
   * @private
   */
  _sendPayload (payload, resultCallback) {
    const url = new URL(this._url)
    const isHttps = url.protocol === 'https:'
    const client = isHttps ? https : http

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 4318),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        ...this._headers,
        'Content-Length': payload.length
      },
      timeout: this._timeout
    }

    const req = client.request(options, (res) => {
      let data = ''

      res.on('data', (chunk) => {
        data += chunk
      })

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resultCallback({ code: 0 })
        } else {
          const error = new Error(`HTTP ${res.statusCode}: ${data}`)
          resultCallback({ code: 1, error })
        }
      })
    })

    req.on('error', (error) => {
      log.error('Error sending OTLP logs:', error)
      resultCallback({ code: 1, error })
    })

    req.on('timeout', () => {
      req.destroy()
      const error = new Error('Request timeout')
      resultCallback({ code: 1, error })
    })

    req.write(payload)
    req.end()
  }

  /**
   * Shuts down the exporter.
   * @returns {Promise<void>} Promise that resolves when shutdown is complete
   */
  shutdown () {
    return Promise.resolve()
  }
}

module.exports = OtlpHttpLogExporter
