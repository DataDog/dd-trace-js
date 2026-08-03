'use strict'

const { performance } = require('node:perf_hooks')

const { context } = require('@opentelemetry/api')
const {
  millisToHrTime,
  sanitizeAttributes,
  timeInputToHrTime,
} = require('../../../../../vendor/dist/@opentelemetry/core')
const { VERSION: packageVersion } = require('../../../../../version')

function toHrTime (timestamp) {
  // The vendored OTel version treats every number before timeOrigin as performance.now().
  // Preserve historical Unix-millisecond inputs as absolute timestamps.
  if (typeof timestamp === 'number' && timestamp >= performance.timeOrigin / 2) {
    return millisToHrTime(timestamp)
  }
  return timeInputToHrTime(timestamp)
}

/**
 * @typedef {import('@opentelemetry/api-logs').LogRecord} LogRecord
 * @typedef {import('@opentelemetry/api-logs').LoggerProvider} LoggerProvider
 * @typedef {import('@opentelemetry/api').SpanContext} SpanContext
 * @typedef {import('@opentelemetry/api').Attributes} Attributes
 * @typedef {import('@opentelemetry/resources').Resource} Resource
 * @typedef {import('@opentelemetry/core').InstrumentationScope} InstrumentationScope
 * @typedef {import('@opentelemetry/core').InstrumentationLibrary} InstrumentationLibrary
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
   * @param {InstrumentationScope} [instrumentationScope] - Instrumentation scope information (newer API).
   *  `name` defaults to 'dd-trace-js';
   *  `version` defaults to tracer version;
   *  `schemaUrl` defaults to '';
   * @param {InstrumentationLibrary} [instrumentationLibrary]
   *  - Instrumentation library information (legacy API) [DEPRECATED in v1.3.0].
   *  `name` defaults to 'dd-trace-js';
   *  `version` defaults to tracer version;
   *  `schemaUrl` defaults to '';
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

    const record = { ...logRecord }
    const timestamp = logRecord.timestamp === undefined ? Date.now() : logRecord.timestamp
    record.timestamp = toHrTime(timestamp)
    record.context = logRecord.context || context.active()

    if (logRecord.observedTimestamp !== undefined) {
      record.observedTimestamp = toHrTime(logRecord.observedTimestamp)
    }

    if (logRecord.attributes) {
      record.attributes = sanitizeAttributes(logRecord.attributes)
    }

    this.loggerProvider.processor.onEmit(record, this.#instrumentationScope)
  }
}

module.exports = Logger
