'use strict'

const { storage } = require('../../../datadog-core')
const { LogChannel } = require('./channels')
const { Log } = require('./log')
const defaultLogger = {
  debug: msg => console.debug(msg), /* eslint-disable-line no-console */
  info: msg => console.info(msg), /* eslint-disable-line no-console */
  warn: msg => console.warn(msg), /* eslint-disable-line no-console */
  error: msg => console.error(msg) /* eslint-disable-line no-console */
}

let enabled = false
let logger = defaultLogger
let logChannel = new LogChannel()

function withNoop (fn) {
  const store = storage('legacy').getStore()

  storage('legacy').enterWith({ noop: true })
  fn()
  storage('legacy').enterWith(store)
}

function unsubscribeAll () {
  logChannel.unsubscribe({ trace: onTrace, debug: onDebug, info: onInfo, warn: onWarn, error: onError })
}

function toggleSubscription (enable, level) {
  unsubscribeAll()

  if (enable) {
    logChannel = new LogChannel(level)
    logChannel.subscribe({ trace: onTrace, debug: onDebug, info: onInfo, warn: onWarn, error: onError })
  }
}

function toggle (enable, level) {
  enabled = enable
  toggleSubscription(enabled, level)
}

function use (newLogger) {
  if (newLogger && newLogger.debug instanceof Function && newLogger.error instanceof Function) {
    logger = newLogger
  }
}

function reset () {
  logger = defaultLogger
  enabled = false
  toggleSubscription(false)
}

function getErrorLog (err) {
  if (err && typeof err.delegate === 'function') {
    const result = err.delegate()
    return Array.isArray(result) ? Log.parse(...result) : Log.parse(result)
  } else {
    return err
  }
}

function onError (err) {
  const { formatted, cause } = getErrorLog(err)

  // calling twice logger.error() because Error cause is only available in nodejs v16.9.0
  // TODO: replace it with Error(message, { cause }) when cause has broad support
  if (formatted) withNoop(() => logger.error(new Error(formatted)))
  if (cause) withNoop(() => logger.error(cause))
}

function onWarn (log) {
  const { formatted, cause } = getErrorLog(log)
  if (formatted) withNoop(() => logger.warn(formatted))
  if (cause) withNoop(() => logger.warn(cause))
}

function onInfo (log) {
  const { formatted, cause } = getErrorLog(log)
  if (formatted) withNoop(() => logger.info(formatted))
  if (cause) withNoop(() => logger.info(cause))
}

function onDebug (log) {
  const { formatted, cause } = getErrorLog(log)
  if (formatted) withNoop(() => logger.debug(formatted))
  if (cause) withNoop(() => logger.debug(cause))
}

function onTrace (log) {
  const { formatted, cause } = getErrorLog(log)
  // Using logger.debug() because not all loggers have trace level,
  // and console.trace() has a completely different meaning.
  if (formatted) withNoop(() => logger.debug(formatted))
  if (cause) withNoop(() => logger.debug(cause))
}

function error (...args) {
  onError(Log.parse(...args))
}

function warn (...args) {
  const log = Log.parse(...args)
  if (!logger.warn) return onDebug(log)

  onWarn(log)
}

function info (...args) {
  const log = Log.parse(...args)
  if (!logger.info) return onDebug(log)

  onInfo(log)
}

function debug (...args) {
  onDebug(Log.parse(...args))
}

function trace (...args) {
  onTrace(Log.parse(...args))
}

module.exports = { use, toggle, reset, error, warn, info, debug, trace }
