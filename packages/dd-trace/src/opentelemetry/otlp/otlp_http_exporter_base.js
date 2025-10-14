'use strict'

const http = require('http')
const { URL } = require('url')
const log = require('../../log')
const telemetryMetrics = require('../../telemetry/metrics')

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

/**
 * Base class for OTLP HTTP exporters.
 *
 * This implementation follows the OTLP HTTP specification:
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *
 * @class OtlpHttpExporterBase
 */
class OtlpHttpExporterBase {
  #telemetryTags

  /**
   * Creates a new OtlpHttpExporterBase instance.
   *
   * @param {string} url - OTLP endpoint URL
   * @param {string} headers - Additional HTTP headers as comma-separated key=value string
   * @param {number} timeout - Request timeout in milliseconds
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {string} defaultPath - Default path to use if URL has no path
   * @param {string} signalType - Signal type for error messages (e.g., 'logs', 'metrics')
   */
  constructor (url, headers, timeout, protocol, defaultPath, signalType) {
    const parsedUrl = new URL(url)

    this.protocol = protocol
    this.signalType = signalType

    // If no path is provided, use default path
    const path = parsedUrl.pathname === '/' ? defaultPath : parsedUrl.pathname
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
   * Gets the telemetry tags for this exporter.
   * @returns {Array<string>} Telemetry tags
   * @protected
   */
  _getTelemetryTags () {
    return this.#telemetryTags
  }

  /**
   * Records telemetry metrics for exported data.
   * @param {string} metricName - Name of the metric to record
   * @param {number} count - Count to increment
   * @protected
   */
  _recordTelemetry (metricName, count) {
    tracerMetrics.count(metricName, this.#telemetryTags).inc(count)
  }

  /**
   * Sends the payload via HTTP request.
   * @param {Buffer|string} payload - The payload to send
   * @param {Function} resultCallback - Callback for the result
   * @protected
   */
  _sendPayload (payload, resultCallback) {
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
      log.error(`Error sending OTLP ${this.signalType}:`, error)
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

  /**
   * Shuts down the exporter.
   * Subclasses can override to add cleanup logic.
   */
  shutdown () {}
}

module.exports = OtlpHttpExporterBase
