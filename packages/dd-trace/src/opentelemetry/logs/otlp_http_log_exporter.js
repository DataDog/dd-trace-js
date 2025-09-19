'use strict'

/**
 * @fileoverview OTLP HTTP Log Exporter implementation for OpenTelemetry logs
 *
 * VERSION SUPPORT:
 * - OTLP Protocol: v1.7.0
 * - Protobuf Definitions: v1.7.0 (vendored from opentelemetry-proto)
 * - Other versions are not supported
 *
 * NOTE: The official @opentelemetry/exporter-logs-otlp-http package is tightly coupled to the
 * OpenTelemetry SDK and requires @opentelemetry/sdk-logs as a dependency. To avoid
 * pulling in the full SDK, we provide our own implementation that is heavily inspired
 * by the existing OpenTelemetry prior art.
 *
 * This implementation is based on:
 * - Official SDK Documentation: https://open-telemetry.github.io/opentelemetry-js/modules/_opentelemetry_sdk-logs.html
 * - LogRecordExporter Interface: https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_sdk-logs.LogRecordExporter.html
 * - OTLP Protocol Specification: https://opentelemetry.io/docs/specs/otlp/
 *
 * Reference implementation (heavily inspired by):
 * - https://github.com/open-telemetry/opentelemetry-js/tree/v2.1.0/packages/opentelemetry-exporter-logs-otlp-http
 * - https://github.com/open-telemetry/opentelemetry-proto/tree/v1.7.0
 */

const https = require('https')
const http = require('http')
const { URL } = require('url')
const log = require('../../log')
const OtlpTransformer = require('./otlp_transformer')

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
   * @param {Object} [config={}] - Configuration options
   * @param {string} [config.url='http://localhost:4318/v1/logs'] - OTLP endpoint URL
   * @param {Object} [config.headers={}] - Additional HTTP headers
   * @param {number} [config.timeout=10000] - Request timeout in milliseconds
   * @param {string} [config.protocol='http/protobuf'] - OTLP protocol (http/protobuf or http/json)
   */
  constructor (config = {}) {
    this._config = config
    this._url = config.url || 'http://localhost:4318/v1/logs'
    this._protocol = config.protocol || 'http/protobuf'

    // Set Content-Type based on protocol
    const contentType = this._protocol === 'http/json'
      ? 'application/json'
      : 'application/x-protobuf'

    this._headers = {
      'Content-Type': contentType,
      'User-Agent': 'dd-trace-js/otlp-exporter',
      ...config.headers
    }
    this._timeout = config.timeout || 10_000
    this._transformer = new OtlpTransformer(config)
  }

  /**
   * Exports log records via OTLP over HTTP.
   *
   * @param {Array} logRecords - Array of log records to export
   * @param {Function} resultCallback - Callback function for export result
   * @param {number} resultCallback.code - Result code (0 = success, 1 = error)
   * @param {Error} [resultCallback.error] - Error object if export failed
   */
  export (logRecords, resultCallback) {
    if (logRecords.length === 0) {
      resultCallback({ code: 0 })
      return
    }

    try {
      const payload = this._transformer.transformLogRecords(logRecords)
      this._sendPayload(payload, resultCallback)
    } catch (error) {
      log.error('Error transforming log records:', error)
      resultCallback({ code: 1, error })
    }
  }

  _sendPayload (payload, resultCallback) {
    const url = new URL(this._url)
    const isHttps = url.protocol === 'https:'
    const client = isHttps ? https : http

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
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

  shutdown () {
    // No cleanup needed for HTTP exporter
    return Promise.resolve()
  }
}

module.exports = OtlpHttpLogExporter
