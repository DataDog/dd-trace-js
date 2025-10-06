'use strict'

const http = require('http')
const { URL } = require('url')
const log = require('../../log')
const OtlpTransformer = require('./otlp_transformer')
const telemetryMetrics = require('../../telemetry/metrics')

/**
 * @typedef {import('@opentelemetry/resources').Resource} Resource
 */

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

/**
 * OtlpHttpMetricExporter exports metrics via OTLP over HTTP.
 *
 * This implementation follows the OTLP HTTP specification:
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *
 * @class OtlpHttpMetricExporter
 */
class OtlpHttpMetricExporter {
  #telemetryTags

  /**
   * Creates a new OtlpHttpMetricExporter instance.
   *
   * @param {string} url - OTLP endpoint URL
   * @param {string} headers - Additional HTTP headers as comma-separated key=value string
   * @param {number} timeout - Request timeout in milliseconds
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {Resource} resource - Resource attributes
   */
  constructor (url, headers, timeout, protocol, resource) {
    this.url = url
    this.protocol = protocol

    // Set Content-Type based on protocol
    const contentType = this.protocol === 'http/json'
      ? 'application/json'
      : 'application/x-protobuf'

    this.headers = {
      'Content-Type': contentType,
      ...this.#parseAdditionalHeaders(headers)
    }
    this.timeout = timeout
    this.transformer = new OtlpTransformer(resource, protocol)

    // Pre-compute telemetry tags for efficiency
    this.#telemetryTags = [
      'protocol:http',
      `encoding:${this.protocol === 'http/json' ? 'json' : 'protobuf'}`
    ]
  }

  /**
   * Exports metrics via OTLP over HTTP.
   *
   * @param {Array} metrics - Array of metric data to export
   * @param {Function} resultCallback - Callback function for export result
   */
  export (metrics, resultCallback) {
    if (metrics.length === 0) {
      resultCallback({ code: 0 })
      return
    }

    const payload = this.transformer.transformMetrics(metrics)
    this.#sendPayload(payload, resultCallback)

    // Count total data points across all metrics
    let dataPointCount = 0
    for (const metric of metrics) {
      if (metric.data) {
        dataPointCount += metric.data.length
      }
    }
    tracerMetrics.count('otel.metric_data_points', this.#telemetryTags).inc(dataPointCount)
  }

  /**
   * Shuts down the exporter.
   * @returns {undefined} Promise that resolves when shutdown is complete
   */
  shutdown () {}

  /**
   * Sends the payload via HTTP request.
   * @param {Buffer|string} payload - The payload to send
   * @param {Function} resultCallback - Callback for the result
   * @private
   */
  #sendPayload (payload, resultCallback) {
    const url = new URL(this.url)

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Length': payload.length
      },
      timeout: this.timeout
    }

    const req = http.request(options, (res) => {
      let responseData = ''
      res.on('data', (chunk) => {
        responseData += chunk
      })

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resultCallback({ code: 0 })
        } else {
          log.error(`OTLP metrics export failed with status ${res.statusCode}: ${responseData}`)
          resultCallback({ code: 1, error: new Error(`HTTP ${res.statusCode}`) })
        }
      })
    })

    req.on('error', (err) => {
      log.error(`OTLP metrics export request failed: ${err.message}`)
      resultCallback({ code: 1, error: err })
    })

    req.on('timeout', () => {
      req.destroy()
      log.error(`OTLP metrics export request timed out after ${this.timeout}ms`)
      resultCallback({ code: 1, error: new Error('Request timeout') })
    })

    req.write(payload)
    req.end()
  }

  /**
   * Parses additional headers from a comma-separated string.
   * @param {string} headersString - Headers string in format "key1=value1,key2=value2"
   * @returns {Record<string, string>} Parsed headers object
   * @private
   */
  #parseAdditionalHeaders (headersString) {
    if (!headersString) {
      return {}
    }

    const headers = {}
    const pairs = headersString.split(',')

    for (const pair of pairs) {
      const [key, value] = pair.split('=').map(s => s.trim())
      if (key && value) {
        headers[key] = value
      }
    }

    return headers
  }
}

module.exports = OtlpHttpMetricExporter
