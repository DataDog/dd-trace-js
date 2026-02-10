'use strict'

const { storage } = require('../../../datadog-core')
const { LogChannel } = require('./channels')
const defaultLogger = {
  debug: msg => console.debug(msg), /* eslint-disable-line no-console */
  info: msg => console.info(msg), /* eslint-disable-line no-console */
  warn: msg => console.warn(msg), /* eslint-disable-line no-console */
  error: msg => console.error(msg), /* eslint-disable-line no-console */
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
  logChannel.unsubscribe({ trace, debug, info, warn, error })
}

function toggleSubscription (enable, level) {
  unsubscribeAll()

  if (enable) {
    logChannel = new LogChannel(level)
    logChannel.subscribe({ trace, debug, info, warn, error })
  }
}

function toggle (enable, level) {
  enabled = enable
  toggleSubscription(enabled, level)
}

function use (newLogger) {
  if (typeof newLogger?.debug === 'function' && typeof newLogger.error === 'function') {
    logger = newLogger
  }
}

function reset () {
  logger = defaultLogger
  enabled = false
  toggleSubscription(false)
}

function error (err) {
  withNoop(() => logger.error(err))
}

function warn (log) {
  withNoop(() => logger.warn ? logger.warn(log) : logger.debug(log))
}

function info (log) {
  withNoop(() => logger.info ? logger.info(log) : logger.debug(log))
}

function debug (log) {
  withNoop(() => logger.debug(log))
}

function trace (log) {
  // Using logger.debug() because not all loggers have trace level,
  // and console.trace() has a completely different meaning.
  withNoop(() => logger.debug(log))
}

module.exports = { use, toggle, reset, error, warn, info, debug, trace }
