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
  storage('legacy').run({ noop: true }, fn)
}

function toggleSubscription (enable, level) {
  logChannel.unsubscribe({ trace, debug, info, warn, error })

  if (enable) {
    logChannel = new LogChannel(level)
    logChannel.subscribe({ trace, debug, info, warn, error })
  }
}

function configure (enable, level, newLogger) {
  enabled = enable
  logger = typeof newLogger?.debug === 'function' && typeof newLogger.error === 'function'
    ? newLogger
    : defaultLogger
  toggleSubscription(enabled, level)
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

module.exports = { configure, error, warn, info, debug, trace }
