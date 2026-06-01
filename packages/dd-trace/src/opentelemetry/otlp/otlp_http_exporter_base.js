'use strict'

const http = require('http')
const { URL } = require('url')
const log = require('../../log')
const telemetryMetrics = require('../../telemetry/metrics')

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

/**
 * Base class for OTLP HTTP exporters.
 *
 * This implementation follows the OTLP HTTP v1.7.0 specification:
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *
 * @class OtlpHttpExporterBase
 */
class OtlpHttpExporterBase {
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

    // Initialize fields setUrl doesn't touch; it fills in hostname/port/path below.
    this.options = {
      method: 'POST',
      timeout,
      headers: {
        'Content-Type': isJson ? 'application/json' : 'application/x-protobuf',
        ...headers,
      },
    }

    this.setUrl(url)

    this.telemetryTags = [
      'protocol:http',
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

    const req = http.request(options, (res) => {
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
  }

  /**
   * Updates the target URL used by this exporter. The URL is used as-is per the OTel spec: the
   * caller is responsible for including the signal-specific path (`/v1/traces` etc.).
   * @param {string} url - New OTLP endpoint URL
   */
  setUrl (url) {
    const parsedUrl = new URL(url)
    this.options.hostname = parsedUrl.hostname
    this.options.port = parsedUrl.port
    this.options.path = parsedUrl.pathname + parsedUrl.search
  }

  /**
   * Shuts down the exporter.
   * Subclasses can override to add cleanup logic.
   */
  shutdown () {}
}

module.exports = OtlpHttpExporterBase
