'use strict'

const http = require('http')
const { URL } = require('url')
const log = require('../../log')
const OtlpTransformer = require('./otlp_transformer')
const telemetryMetrics = require('../../telemetry/metrics')

/**
 * @typedef {import('@opentelemetry/resources').Resource} Resource
 * @typedef {import('@opentelemetry/api-logs').LogRecord} LogRecord
 *
*/

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
  #telemetryTags

  DEFAULT_LOGS_PATH = '/v1/logs'

  /**
   * Creates a new OtlpHttpLogExporter instance.
   *
   * @param {string} url - OTLP endpoint URL
   * @param {string} headers - Additional HTTP headers as comma-separated key=value string
   * @param {number} timeout - Request timeout in milliseconds
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {Resource} resource - Resource attributes
   */
  constructor (url, headers, timeout, protocol, resource) {
    const parsedUrl = new URL(url)

    this.protocol = protocol
    this.transformer = new OtlpTransformer(resource, protocol)
    // If no path is provided, use default path
    const path = parsedUrl.pathname === '/' ? this.DEFAULT_LOGS_PATH : parsedUrl.pathname
    const isJson = protocol === 'http/json'
    this.options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: path + parsedUrl.search,
      method: 'POST',
      timeout,
      headers: {
        'Content-Type': isJson ? 'application/json' : 'application/x-protobuf',
        ...this.#parseAdditionalHeaders(headers)
      }
    }
    this.#telemetryTags = [
      'protocol:http',
      `encoding:${isJson ? 'json' : 'protobuf'}`
    ]
  }

  /**
   * Exports log records via OTLP over HTTP.
   *
   * @param {LogRecord[]} logRecords - Array of enriched log records to export
   * @param {Function} resultCallback - Callback function for export result
   */
  export (logRecords, resultCallback) {
    if (logRecords.length === 0) {
      resultCallback({ code: 0 })
      return
    }

    const payload = this.transformer.transformLogRecords(logRecords)
    this.#sendPayload(payload, resultCallback)
    tracerMetrics.count('otel.log_records', this.#telemetryTags).inc(logRecords.length)
  }

  /**
   * Sends the payload via HTTP request.
   * @param {Buffer|string} payload - The payload to send
   * @param {Function} resultCallback - Callback for the result
   * @private
   */
  #sendPayload (payload, resultCallback) {
    const options = {
      ...this.options,
      headers: {
        ...this.options.headers,
        'Content-Length': payload.length
      }
    }

    const req = http.request(options, (res) => {
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
   * Parses additional HTTP headers from a comma-separated string.
   * @param {string} headersString - Comma-separated key=value pairs
   * @returns {Record<string, string>} Parsed headers object
   * @private
   */
  #parseAdditionalHeaders (headersString) {
    const headers = {}
    let key = ''
    let value = ''
    let readingKey = true

    for (const char of headersString) {
      if (readingKey) {
        if (char === '=') {
          readingKey = false
          key = key.trim()
        } else {
          key += char
        }
      } else if (char === ',') {
        value = value.trim()
        if (key && value) {
          headers[key] = value
        }
        key = ''
        value = ''
        readingKey = true
      } else {
        value += char
      }
    }

    // Add the last pair if present
    if (!readingKey) {
      value = value.trim()
      if (value) {
        headers[key] = value
      }
    }

    return headers
  }
}

module.exports = OtlpHttpLogExporter
