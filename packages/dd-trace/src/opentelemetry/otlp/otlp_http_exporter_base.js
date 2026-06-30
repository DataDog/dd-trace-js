'use strict'

const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')
const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const telemetryMetrics = require('../../telemetry/metrics')

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')
const legacyStorage = storage('legacy')

/**
 * Base class for OTLP HTTP exporters.
 *
 * This implementation follows the OTLP HTTP v1.7.0 specification:
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *
 * @class OtlpHttpExporterBase
 */
class OtlpHttpExporterBase {
  #transport = https

  /**
   * Creates a new OtlpHttpExporterBase instance.
   *
   * @param {string} url - OTLP endpoint URL (callers are expected to supply the full signal URL)
   * @param {Record<string, string>|undefined} headers - Additional HTTP headers parsed from the
   *   corresponding `OTEL_EXPORTER_OTLP_*_HEADERS` env by the MAP parser.
   * @param {number} timeout - Request timeout in milliseconds
   * @param {string} protocol - OTLP protocol (http/protobuf or http/json)
   * @param {string} signalType - Signal type for error messages (e.g., 'logs', 'metrics')
   */
  constructor (url, headers, timeout, protocol, signalType) {
    this.protocol = protocol
    this.signalType = signalType

    const isJson = protocol === 'http/json'

    const parsedUrl = new URL(url)
    this.#transport = parsedUrl.protocol === 'http:' ? http : https
    this.options = {
      method: 'POST',
      timeout,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'Content-Type': isJson ? 'application/json' : 'application/x-protobuf',
        ...headers,
      },
    }

    this.telemetryTags = [
      `protocol:${this.#transport === https ? 'https' : 'http'}`,
      `encoding:${isJson ? 'json' : 'protobuf'}`,
    ]
  }

  /**
   * Records telemetry metrics for exported data.
   * @param {string} metricName - Name of the metric to record
   * @param {number} count - Count to increment
   * @param {Array<string>} [additionalTags] - Optional custom tags (defaults to this exporter's tags)
   * @protected
   */
  recordTelemetry (metricName, count, additionalTags) {
    // @ts-expect-error - additionalTags is optional and can be undefined
    if (additionalTags?.length > 0) {
      tracerMetrics.count(metricName, [...this.telemetryTags, ...additionalTags || []]).inc(count)
    } else {
      tracerMetrics.count(metricName, this.telemetryTags).inc(count)
    }
  }

  /**
   * Sends the payload via HTTP request.
   * @param {Buffer|string} payload - The payload to send
   * @param {Function} resultCallback - Callback for the result
   * @protected
   */
  sendPayload (payload, resultCallback) {
    const options = {
      ...this.options,
      headers: {
        ...this.options.headers,
        'Content-Length': payload.length,
      },
    }

    legacyStorage.run({ noop: true }, () => {
      const req = this.#transport.request(options, (res) => {
        let data = ''

        res.on('data', (chunk) => {
          data += chunk
        })

        res.once('end', () => {
          // @ts-expect-error - res.statusCode can be undefined
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resultCallback({ code: 0 })
          } else {
            const error = new Error(`HTTP ${res.statusCode}: ${data}`)
            resultCallback({ code: 1, error })
          }
        })
      })

      req.on('error', (error) => {
        log.error('Error sending OTLP %s:', this.signalType, error)
        resultCallback({ code: 1, error })
      })

      req.once('timeout', () => {
        req.destroy()
        const error = new Error('Request timeout')
        resultCallback({ code: 1, error })
      })

      req.write(payload)
      req.end()
    })
  }

  shutdown () {}
}

module.exports = OtlpHttpExporterBase
