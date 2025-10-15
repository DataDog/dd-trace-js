'use strict'

const { sanitizeAttributes } = require('@opentelemetry/core')
const { context } = require('@opentelemetry/api')
const packageVersion = require('../../../../../package.json').version
/**
 * @typedef {import('@opentelemetry/api-logs').LogRecord} LogRecord
 * @typedef {import('@opentelemetry/api').SpanContext} SpanContext
 * @typedef {import('@opentelemetry/api').Attributes} Attributes
 * @typedef {import('@opentelemetry/resources').Resource} Resource
 * @typedef {import('@opentelemetry/core').InstrumentationScope} InstrumentationScope
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
  #instrumentationScope

  /**
   * Creates a new Logger instance.
   *
   * @param {LoggerProvider} loggerProvider - Parent logger provider
   * @param {InstrumentationScope} [instrumentationScope] - Instrumentation scope information (newer API)
   * @param {Object} [instrumentationLibrary] - Instrumentation library information (legacy API) [DEPRECATED in v1.3.0]
   * @param {InstrumentationScope} [instrumentationScope.name] - Library name (defaults to 'dd-trace-js')
   * @param {InstrumentationScope} [instrumentationScope.version] - Library version (defaults to tracer version)
   * @param {string} [instrumentationLibrary.name] - Library name (legacy, defaults to 'dd-trace-js')
   * @param {string} [instrumentationLibrary.version] - Library version (legacy, defaults to tracer version)
   */
  constructor (loggerProvider, instrumentationScope, instrumentationLibrary) {
    this.loggerProvider = loggerProvider

    // Support both newer instrumentationScope and legacy instrumentationLibrary
    const scope = instrumentationScope || instrumentationLibrary
    this.#instrumentationScope = {
      name: scope?.name || 'dd-trace-js',
      version: scope?.version || packageVersion,
      schemaUrl: scope?.schemaUrl || '',
    }
  }

  /**
   * Emits a log record.
   *
   * @param {LogRecord} logRecord - The log record to emit
   * @returns {void}
   */
  emit (logRecord) {
    if (this.loggerProvider.isShutdown || !this.loggerProvider.processor) {
      return
    }

    if (logRecord.attributes) {
      logRecord.attributes = sanitizeAttributes(logRecord.attributes)
    }

    // Note: timestamp is in nanoseconds (as defined by OpenTelemetry LogRecord API)
    if (!logRecord.timestamp) {
      logRecord.timestamp = Number(process.hrtime.bigint())
    }

    if (!logRecord.context) {
      // Store span context in the log record context for trace correlation
      logRecord.context = context.active()
    }

    this.loggerProvider.processor.onEmit(logRecord, this.#instrumentationScope)
  }
}

module.exports = Logger
