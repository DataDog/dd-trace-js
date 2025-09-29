'use strict'

const { sanitizeAttributes } = require('@opentelemetry/core')
const { trace, context } = require('@opentelemetry/api')
const packageVersion = require('../../../../../package.json').version
/**
 * @typedef {import('@opentelemetry/api-logs').LogRecord} LogRecord
 * @typedef {import('@opentelemetry/api').SpanContext} SpanContext
 * @typedef {import('@opentelemetry/api').Attributes} Attributes
 * @typedef {import('@opentelemetry/resources').Resource} Resource
 */
/**
 * Logger provides methods to emit log records.
 *
 * This implementation follows the OpenTelemetry JavaScript API Logger:
 * https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_api-logs.Logger.html
 *
 * @class Logger
 */
class Logger {
  #instrumentationLibrary

  /**
   * Creates a new Logger instance.
   *
   * @param {LoggerProvider} loggerProvider - Parent logger provider
   * @param {Object} [instrumentationLibrary] - Instrumentation library information
   * @param {string} [instrumentationLibrary.name] - Library name (defaults to 'dd-trace-js')
   * @param {string} [instrumentationLibrary.version] - Library version (defaults to tracer version)
   */
  constructor (loggerProvider, instrumentationLibrary) {
    this.loggerProvider = loggerProvider
    this.#instrumentationLibrary = {
      name: instrumentationLibrary?.name || 'dd-trace-js',
      version: instrumentationLibrary?.version || packageVersion
    }
  }

  /**
   * Gets the resource associated with this logger.
   * @returns {Resource} The resource attributes
   */
  get resource () {
    return this.loggerProvider.resource
  }

  /**
   * Emits a log record.
   *
   * @param {LogRecord} logRecord - The log record to emit
   */
  emit (logRecord) {
    if (this.loggerProvider.isShutdown) {
      return
    }

    if (!this.loggerProvider.processor) {
      return
    }

    if (logRecord.attributes) {
      logRecord.attributes = sanitizeAttributes(logRecord.attributes)
    }

    // Set default timestamp if not provided
    if (!logRecord.timestamp) {
      logRecord.timestamp = Date.now() * 1_000_000
    }

    // Set observed timestamp if not provided
    if (!logRecord.observedTimestamp) {
      logRecord.observedTimestamp = logRecord.timestamp
    }

    // Use the provided context or get the current active context
    const activeContext = logRecord.context || context.active()

    // Extract span context from the active context for trace correlation
    const spanContext = this.#getSpanContext(activeContext)

    // Create enriched log record with all expected fields
    // Contains: severityText, severityNumber, body, timestamp, observedTimestamp,
    // attributes, resource, instrumentationLibrary, traceId, spanId, traceFlags
    const enrichedLogRecord = {
      timestamp: logRecord.timestamp,
      observedTimestamp: logRecord.observedTimestamp,
      severityText: logRecord.severityText || '',
      severityNumber: logRecord.severityNumber || 0,
      body: logRecord.body || '',
      attributes: logRecord.attributes,
      // Newer versions of the OpenTelemetry Logs API require instrumentationScope instead of instrumentationLibrary
      instrumentationLibrary: logRecord.instrumentationScope ||
                          logRecord.instrumentationLibrary ||
                          this.#instrumentationLibrary,
      traceId: spanContext?.traceId || '',
      spanId: spanContext?.spanId || '',
      traceFlags: spanContext?.traceFlags || 0
    }

    this.loggerProvider.processor.onEmit(enrichedLogRecord)
  }

  /**
   * Extracts span context from the OpenTelemetry context for trace correlation.
   * @param {Object} activeContext - The OpenTelemetry context
   * @returns {SpanContext|null} Span context or null if not available
   * @private
   */
  #getSpanContext (activeContext) {
    const activeSpan = trace.getSpan(activeContext)
    if (activeSpan) {
      const spanContext = activeSpan.spanContext()
      if (spanContext?.traceId && spanContext.spanId) {
        return {
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          traceFlags: spanContext.traceFlags
        }
      }
    }
    return null
  }
}

module.exports = Logger
