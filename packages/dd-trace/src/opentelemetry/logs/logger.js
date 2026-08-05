'use strict'

const { performance } = require('node:perf_hooks')

const { context } = require('@opentelemetry/api')
const {
  millisToHrTime,
  sanitizeAttributes,
  timeInputToHrTime,
} = require('../../../../../vendor/dist/@opentelemetry/core')
const { VERSION: packageVersion } = require('../../../../../version')
const log = require('../../log')

const MAX_DATE_MILLISECONDS = 8.64e15
const NANOSECONDS_PER_SECOND = 1e9
let invalidTimestampWarningLogged = false

function isValidHrTime (hrTime) {
  return Array.isArray(hrTime) &&
    hrTime.length === 2 &&
    Number.isInteger(hrTime[0]) &&
    Number.isInteger(hrTime[1]) &&
    hrTime[1] >= 0 &&
    hrTime[1] < NANOSECONDS_PER_SECOND
}

function toHrTime (timestamp) {
  if (Number.isFinite(timestamp)) {
    // Older versions documented numeric timestamps as Unix nanoseconds.
    if (Math.abs(timestamp) > MAX_DATE_MILLISECONDS) {
      const seconds = Math.trunc(timestamp / NANOSECONDS_PER_SECOND)
      const hrTime = [seconds, timestamp - seconds * NANOSECONDS_PER_SECOND]
      return isValidHrTime(hrTime) ? hrTime : undefined
    }

    if (timestamp >= 0 && timestamp <= performance.now()) {
      // A number within this process's elapsed time is a performance timestamp.
      return timeInputToHrTime(timestamp)
    }

    // All other numbers are Unix milliseconds, including historical dates.
    return millisToHrTime(timestamp)
  }

  if (timestamp instanceof Date) {
    const hrTime = millisToHrTime(timestamp.getTime())
    return isValidHrTime(hrTime) ? hrTime : undefined
  }

  return isValidHrTime(timestamp) ? timestamp : undefined
}

function normalizeTimestamp (timestamp) {
  if (timestamp !== undefined) {
    const hrTime = toHrTime(timestamp)
    if (hrTime) return hrTime

    if (!invalidTimestampWarningLogged) {
      invalidTimestampWarningLogged = true
      log.warn('Invalid OpenTelemetry log timestamp; using the current time instead')
    }
  }

  return millisToHrTime(Date.now())
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

    const record = {
      ...logRecord,
      timestamp: normalizeTimestamp(logRecord.timestamp),
      context: logRecord.context || context.active(),
      ...(logRecord.observedTimestamp !== undefined && {
        observedTimestamp: normalizeTimestamp(logRecord.observedTimestamp),
      }),
      ...(logRecord.attributes && {
        attributes: sanitizeAttributes(logRecord.attributes),
      }),
    }

    this.loggerProvider.processor.onEmit(record, this.#instrumentationScope)
  }
}

module.exports = Logger
