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
  const store = storage.getStore()

  storage.enterWith({ noop: true })
  fn()
  storage.enterWith(store)
}

function unsubscribeAll () {
  logChannel.unsubscribe({ debug, info, warn, error: onError })
}

function toggleSubscription (enable, level) {
  unsubscribeAll()

  if (enable) {
    logChannel = new LogChannel(level)
    logChannel.subscribe({ debug, info, warn, error: onError })
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
  if (err?.delegate && typeof err.delegate === 'function') {
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

function error (...args) {
  onError(Log.parse(...args))
}

function warn (message) {
  if (!logger.warn) return debug(message)
  withNoop(() => logger.warn(message))
}

function info (message) {
  if (!logger.info) return debug(message)
  withNoop(() => logger.info(message))
}

function debug (message) {
  withNoop(() => logger.debug(message))
}

module.exports = { use, toggle, reset, error, warn, info, debug }
