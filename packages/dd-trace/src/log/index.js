'use strict'

const { inspect } = require('util')

const { getValueFromEnvSources } = require('../config/helper')
// Eager require restores the original startup module-load order: pulling `config/defaults` here
// also installs the instrumented `dns` it transitively loads before the tracer/agent connects.
// `config/defaults` defers its own `dns` require until after it exports, so this no longer hits
// the `config/defaults` <-> log parse cycle that motivated the lazy require below.
const { defaults } = require('../config/defaults')
const { traceChannel, debugChannel, infoChannel, warnChannel, errorChannel } = require('./channels')
const logWriter = require('./writer')
const { Log, LogConfig, NoTransmitError } = require('./log')

// In most places where we know we want to mute a log we use log.error() directly
const NO_TRANSMIT = new LogConfig(false)

const log = {
  LogConfig,
  NO_TRANSMIT,
  NoTransmitError,

  trace (...args) {
    if (traceChannel.hasSubscribers) {
      const logRecord = {}

      Error.captureStackTrace(logRecord, log.trace)

      const stack = logRecord.stack.split('\n')
      const fn = stack[1].replace(/^\s+at ([^\s]+) .+/, '$1')
      const options = { depth: 2, breakLength: Infinity, compact: true, maxArrayLength: Infinity }
      const params = args.map(a => inspect(a, options)).join(', ')

      stack[0] = `Trace: ${fn}(${params})`

      publishFormatted(traceChannel, null, stack.join('\n'))
    }
    // TODO: Why do we allow chaining here? This is likely not used anywhere.
    // If it is used, that seems like a mistake.
    return log
  },

  debug (...args) {
    publishFormatted(debugChannel, null, ...args)
    return log
  },

  info (...args) {
    publishFormatted(infoChannel, null, ...args)
    return log
  },

  warn (...args) {
    publishFormatted(warnChannel, null, ...args)
    return log
  },

  error (...args) {
    publishFormatted(errorChannel, formatted => {
      const stackTraceLimitBackup = Error.stackTraceLimit
      Error.stackTraceLimit = 0
      const newError = new Error(formatted)
      Error.stackTraceLimit = stackTraceLimitBackup
      Error.captureStackTrace(newError, log.error)
      return newError
    }, ...args)
    return log
  },

  errorWithoutTelemetry (...args) {
    args.push(NO_TRANSMIT)
    publishFormatted(errorChannel, null, ...args)
    return log
  },

  configure (options) {
    const logger = options.logger
    const logLevel = options.logLevel ??
        getValueFromEnvSources('DD_TRACE_LOG_LEVEL', true) ??
        defaults?.logLevel
    const enabled = getValueFromEnvSources('DD_TRACE_DEBUG', true) ??
      // TODO: Handle this by adding a log buffer so that configure may be called with the actual configurations.
      // eslint-disable-next-line eslint-rules/eslint-process-env
      (process.env.OTEL_LOG_LEVEL === 'debug' || defaults?.DD_TRACE_DEBUG)
    logWriter.configure(enabled, logLevel, logger)

    return enabled
  },
}

function publishFormatted (ch, formatter, ...args) {
  if (ch.hasSubscribers) {
    const log = Log.parse(...args)
    const { formatted, cause } = getErrorLog(log)

    // calling twice ch.publish() because Error cause is only available in Node.js v16.9.0
    // TODO: replace it with Error(message, { cause }) when cause has broad support
    if (formatted) ch.publish(formatter?.(formatted) || formatted)
    if (cause) ch.publish(cause)
  }
}

function getErrorLog (err) {
  if (typeof err?.delegate === 'function') {
    const result = err.delegate(...err.args)
    return Array.isArray(result) ? Log.parse(...result) : Log.parse(result)
  }
  return err
}

// Assign before the bootstrap configure() call: an invalid DD_TRACE_LOG_LEVEL
// makes config/defaults re-require this module to warn, which must observe the
// fully built log object rather than a half-initialized one.
module.exports = log

log.configure({})
