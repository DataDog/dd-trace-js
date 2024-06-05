'use strict'

const { storage } = require('../../../datadog-core')
const { LogChannel } = require('./channels')
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
  logChannel.unsubscribe({ debug, info, warn, error })
}

function toggleSubscription (enable, level) {
  unsubscribeAll()

  if (enable) {
    logChannel = new LogChannel(level)
    logChannel.subscribe({ debug, info, warn, error })
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

function error (err) {
  if (typeof err !== 'object' || !err) {
    err = String(err)
  } else if (!err.stack) {
    err = String(err.message || err)
  }

  if (typeof err === 'string') {
    err = new Error(err)
  }

  withNoop(() => logger.error(err))
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
