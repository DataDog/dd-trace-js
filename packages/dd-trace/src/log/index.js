'use strict'

const { inspect } = require('util')

const { traceChannel, debugChannel, infoChannel, warnChannel, errorChannel } = require('./channels')
const logWriter = require('./writer')
const { Log, LogConfig, NoTransmitError } = require('./log')

/**
 * @typedef {import('../config/config-types').ConfigProperties} ConfigProperties
 * @typedef {Partial<Pick<ConfigProperties, 'DD_TRACE_DEBUG' | 'logger' | 'logLevel'>>} LoggerConfig
 * @typedef {import('diagnostics_channel').Channel} Channel
 * @typedef {((formatted: string) => string | Error) | null} LogFormatter
 * @typedef {[Channel, LogFormatter, unknown[]]} BufferedLog
 */

const NO_TRANSMIT = new LogConfig(false)

/** @type {BufferedLog[]} */
let buffer = []

const log = {
  LogConfig,
  NO_TRANSMIT,
  NoTransmitError,
  trace: bufferTrace,
  debug: bufferDebug,
  info: bufferInfo,
  warn: bufferWarn,
  error: bufferError,
  errorWithoutTelemetry: bufferErrorWithoutTelemetry,

  /**
   * @param {LoggerConfig} options
   */
  configure (options) {
    const enabled = options.DD_TRACE_DEBUG === true
    logWriter.configure(enabled, options.logLevel, options.logger)
    setLogMethods(enabled)

    const buffered = buffer
    buffer = []

    if (enabled) {
      for (const [channel, formatter, args] of buffered) {
        publishFormatted(channel, formatter, ...args)
      }
    }

    return enabled
  },
}

/**
 * @param {...unknown} args
 */
function bufferTrace (...args) {
  const formatted = formatTrace(args)
  bufferLog(traceChannel, null, [formatted])
}

/**
 * @param {...unknown} args
 */
function bufferDebug (...args) {
  bufferLog(debugChannel, null, args)
}

/**
 * @param {...unknown} args
 */
function bufferInfo (...args) {
  bufferLog(infoChannel, null, args)
}

/**
 * @param {...unknown} args
 */
function bufferWarn (...args) {
  bufferLog(warnChannel, null, args)
}

/**
 * @param {...unknown} args
 */
function bufferError (...args) {
  bufferLog(errorChannel, formatError, args)
}

/**
 * @param {...unknown} args
 */
function bufferErrorWithoutTelemetry (...args) {
  args.push(NO_TRANSMIT)
  bufferLog(errorChannel, null, args)
}

/**
 * @param {Channel} channel
 * @param {LogFormatter} formatter
 * @param {unknown[]} args
 */
function bufferLog (channel, formatter, args) {
  buffer.push([channel, formatter, args])
}

/**
 * @param {...unknown} args
 */
function writeTrace (...args) {
  if (traceChannel.hasSubscribers) {
    const formatted = formatTrace(args)
    publishFormatted(traceChannel, null, formatted)
  }
}

/**
 * @param {...unknown} args
 */
function writeDebug (...args) {
  publishFormatted(debugChannel, null, ...args)
}

/**
 * @param {...unknown} args
 */
function writeInfo (...args) {
  publishFormatted(infoChannel, null, ...args)
}

/**
 * @param {...unknown} args
 */
function writeWarn (...args) {
  publishFormatted(warnChannel, null, ...args)
}

/**
 * @param {...unknown} args
 */
function writeError (...args) {
  publishFormatted(errorChannel, formatError, ...args)
}

/**
 * @param {...unknown} args
 */
function writeErrorWithoutTelemetry (...args) {
  args.push(NO_TRANSMIT)
  publishFormatted(errorChannel, null, ...args)
}

function noopLog () {}

/**
 * @param {boolean} enabled
 */
function setLogMethods (enabled) {
  log.trace = enabled ? writeTrace : noopLog
  log.debug = enabled ? writeDebug : noopLog
  log.info = enabled ? writeInfo : noopLog
  log.warn = enabled ? writeWarn : noopLog
  log.error = enabled ? writeError : noopLog
  log.errorWithoutTelemetry = enabled ? writeErrorWithoutTelemetry : noopLog
}

/**
 * @param {unknown[]} args
 */
function formatTrace (args) {
  const logRecord = { stack: '' }

  Error.captureStackTrace(logRecord, log.trace)

  const stack = logRecord.stack.split('\n')
  const fn = stack[1].replace(/^\s+at ([^\s]+) .+/, '$1')
  const options = { depth: 2, breakLength: Infinity, compact: true, maxArrayLength: Infinity }
  const params = args.map(a => inspect(a, options)).join(', ')

  stack[0] = `Trace: ${fn}(${params})`

  return stack.join('\n')
}

/**
 * @param {string} formatted
 */
function formatError (formatted) {
  const stackTraceLimitBackup = Error.stackTraceLimit
  Error.stackTraceLimit = 0
  const newError = new Error(formatted)
  Error.stackTraceLimit = stackTraceLimitBackup
  Error.captureStackTrace(newError, log.error)
  return newError
}

/**
 * @param {Channel} channel
 * @param {LogFormatter} formatter
 * @param {...unknown} args
 */
function publishFormatted (channel, formatter, ...args) {
  if (channel.hasSubscribers) {
    const log = Log.parse(...args)
    const { formatted, cause } = getErrorLog(log)

    // calling twice channel.publish() because Error cause is only available in Node.js v16.9.0
    // TODO: replace it with Error(message, { cause }) when cause has broad support
    if (formatted) channel.publish(formatter?.(formatted) || formatted)
    if (cause) channel.publish(cause)
  }
}

/**
 * @param {Log} errorLog
 */
function getErrorLog (errorLog) {
  if (typeof errorLog?.delegate === 'function') {
    const result = errorLog.delegate()
    return Array.isArray(result) ? Log.parse(...result) : Log.parse(result)
  }
  return errorLog
}

module.exports = log
