'use strict'

const http2 = require('node:http2')
const { URL } = require('node:url')

const log = require('../../log')
const telemetryMetrics = require('../../telemetry/metrics')

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

const GRPC_STATUS_OK = 0

/**
 * Base class for OTLP gRPC exporters.
 *
 * Uses Node.js built-in http2 module to send protobuf-encoded OTLP data
 * via gRPC unary calls over HTTP/2.
 *
 * OTLP/gRPC specification: https://opentelemetry.io/docs/specs/otlp/#otlpgrpc
 *
 * @class OtlpGrpcExporterBase
 */
class OtlpGrpcExporterBase {
  #url
  #headers
  #timeout
  #session
  #servicePath

  /**
   * Creates a new OtlpGrpcExporterBase instance.
   *
   * @param {string} url - OTLP gRPC endpoint URL (e.g. http://localhost:4317)
   * @param {string} headers - Additional headers as comma-separated key=value string
   * @param {number} timeout - Request timeout in milliseconds
   * @param {string} servicePath - gRPC service/method path
   *   (e.g. /opentelemetry.proto.collector.trace.v1.TraceService/Export)
   * @param {string} signalType - Signal type for error messages (e.g., 'traces', 'logs')
   */
  constructor (url, headers, timeout, servicePath, signalType) {
    this.#url = new URL(url)
    this.#headers = this.#parseAdditionalHeaders(headers)
    this.#timeout = timeout
    this.#servicePath = servicePath
    this.signalType = signalType
    this.#session = undefined
    this.telemetryTags = [
      'protocol:grpc',
      'encoding:protobuf',
    ]
  }

  /**
   * Records telemetry metrics for exported data.
   *
   * @param {string} metricName - Name of the metric to record
   * @param {number} count - Count to increment
   * @param {Array<string>} [additionalTags] - Optional custom tags
   * @protected
   */
  recordTelemetry (metricName, count, additionalTags) {
    if (additionalTags?.length > 0) {
      tracerMetrics.count(metricName, [...this.telemetryTags, ...additionalTags]).inc(count)
    } else {
      tracerMetrics.count(metricName, this.telemetryTags).inc(count)
    }
  }

  /**
   * Sends a protobuf-encoded payload via gRPC over HTTP/2.
   *
   * Frames the payload with the gRPC Length-Prefixed-Message format:
   * - 1 byte: compression flag (0 = uncompressed)
   * - 4 bytes: message length (big-endian uint32)
   * - N bytes: protobuf message
   *
   * @param {Buffer} payload - Protobuf-encoded payload to send
   * @param {Function} resultCallback - Callback with { code, error? }
   * @protected
   */
  sendPayload (payload, resultCallback) {
    const session = this.#getOrCreateSession()

    const grpcFrame = Buffer.alloc(5 + payload.length)
    grpcFrame[0] = 0 // uncompressed
    grpcFrame.writeUInt32BE(payload.length, 1)
    payload.copy(grpcFrame, 5)

    const headers = {
      [http2.constants.HTTP2_HEADER_METHOD]: 'POST',
      [http2.constants.HTTP2_HEADER_PATH]: this.#servicePath,
      [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc',
      te: 'trailers',
      ...this.#headers,
    }

    const stream = session.request(headers)
    let responseData = Buffer.alloc(0)
    let timedOut = false

    stream.setTimeout(this.#timeout, () => {
      timedOut = true
      stream.close(http2.constants.NGHTTP2_CANCEL)
      resultCallback({ code: 1, error: new Error('gRPC request timeout') })
    })

    stream.on('data', (chunk) => {
      responseData = Buffer.concat([responseData, chunk])
    })

    stream.on('trailers', (trailers) => {
      if (timedOut) return

      const grpcStatus = Number.parseInt(trailers['grpc-status'], 10)
      if (grpcStatus === GRPC_STATUS_OK) {
        resultCallback({ code: 0 })
      } else {
        const grpcMessage = trailers['grpc-message'] || `gRPC status ${grpcStatus}`
        resultCallback({ code: 1, error: new Error(grpcMessage) })
      }
    })

    stream.on('error', (error) => {
      if (timedOut) return
      log.error('Error sending OTLP %s via gRPC:', this.signalType, error)
      this.#destroySession()
      resultCallback({ code: 1, error })
    })

    stream.end(grpcFrame)
  }

  /**
   * Gets or creates the HTTP/2 session (connection) to the gRPC server.
   * Reuses the existing session if it is still open.
   *
   * @returns {http2.ClientHttp2Session} The HTTP/2 session
   */
  #getOrCreateSession () {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) {
      return this.#session
    }

    const authority = `${this.#url.protocol}//${this.#url.host}`
    this.#session = http2.connect(authority)

    this.#session.on('error', (error) => {
      log.error('OTLP gRPC session error for %s:', this.signalType, error)
      this.#destroySession()
    })

    this.#session.once('goaway', () => {
      this.#destroySession()
    })

    return this.#session
  }

  /**
   * Destroys the current HTTP/2 session.
   */
  #destroySession () {
    if (this.#session) {
      this.#session.destroy()
      this.#session = undefined
    }
  }

  /**
   * Parses additional headers from a comma-separated string.
   *
   * @param {string} headersString - Comma-separated key=value pairs
   * @returns {Record<string, string>} Parsed headers object
   */
  #parseAdditionalHeaders (headersString) {
    const headers = {}
    if (!headersString) return headers

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

    if (!readingKey) {
      value = value.trim()
      if (value) {
        headers[key] = value
      }
    }

    return headers
  }

  /**
   * Shuts down the exporter and closes the HTTP/2 session.
   */
  shutdown () {
    this.#destroySession()
  }
}

module.exports = OtlpGrpcExporterBase
