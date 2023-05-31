'use strict'

const { storage } = require('../../../datadog-core')
const { getChannelLogLevel, debugChannel, infoChannel, warnChannel, errorChannel } = require('./channels')

const defaultLogger = {
  debug: msg => console.debug(msg), /* eslint-disable-line no-console */
  info: msg => console.info(msg), /* eslint-disable-line no-console */
  warn: msg => console.warn(msg), /* eslint-disable-line no-console */
  error: msg => console.error(msg) /* eslint-disable-line no-console */
}

let enabled = false
let logger = defaultLogger
let logLevel = getChannelLogLevel()

function withNoop (fn) {
  const store = storage.getStore()

  storage.enterWith({ noop: true })
  fn()
  storage.enterWith(store)
}

function unsubscribeAll () {
  if (debugChannel.hasSubscribers) {
    debugChannel.unsubscribe(onDebug)
  }
  if (infoChannel.hasSubscribers) {
    infoChannel.unsubscribe(onInfo)
  }
  if (warnChannel.hasSubscribers) {
    warnChannel.unsubscribe(onWarn)
  }
  if (errorChannel.hasSubscribers) {
    errorChannel.unsubscribe(onError)
  }
}

function toggleSubscription (enable) {
  unsubscribeAll()

  if (enable) {
    if (debugChannel.logLevel >= logLevel) {
      debugChannel.subscribe(onDebug)
    }
    if (infoChannel.logLevel >= logLevel) {
      infoChannel.subscribe(onInfo)
    }
    if (warnChannel.logLevel >= logLevel) {
      warnChannel.subscribe(onWarn)
    }
    if (errorChannel.logLevel >= logLevel) {
      errorChannel.subscribe(onError)
    }
  }
}

function toggle (enable, level) {
  if (level !== undefined) {
    logLevel = getChannelLogLevel(level)
  }
  enabled = enable
  toggleSubscription(enabled)
}

function use (newLogger) {
  if (newLogger && newLogger.debug instanceof Function && newLogger.error instanceof Function) {
    logger = newLogger
  }
}

function reset () {
  logger = defaultLogger
  enabled = false
  logLevel = getChannelLogLevel()
  toggleSubscription(false)
}

function onError (err) {
  if (enabled) error(err)
}

function onWarn (message) {
  if (enabled) warn(message)
}

function onInfo (message) {
  if (enabled) info(message)
}

function onDebug (message) {
  if (enabled) debug(message)
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
