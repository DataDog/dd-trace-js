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

function processMsg (msg) {
  return typeof msg === 'function' ? msg() : msg
}

function withNoop (fn) {
  const store = storage.getStore()

  storage.enterWith({ noop: true })
  fn()
  storage.enterWith(store)
}

function unsubscribeAll () {
  debugChannel.unsubscribe(onDebug)
  infoChannel.unsubscribe(onInfo)
  warnChannel.unsubscribe(onWarn)
  errorChannel.unsubscribe(onError)
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
  if (enabled) {
    if (err instanceof Function) {
      err = err()
    }

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
}

function onWarn (message) {
  if (!logger.warn) return onDebug(message)
  if (enabled) {
    withNoop(() => logger.warn(processMsg(message)))
  }
}

function onInfo (message) {
  if (!logger.info) return onDebug(message)
  if (enabled) {
    withNoop(() => logger.info(processMsg(message)))
  }
}

function onDebug (message) {
  if (enabled) {
    withNoop(() => logger.debug(processMsg(message)))
  }
}

module.exports = { use, toggle, reset }
