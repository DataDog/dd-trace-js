'use strict'

const { storage } = require('../../datadog-core')
const { Level, subscribe, unsubscribe } = require('./log_channels')

const _defaultLogger = {
  debug: msg => console.debug(msg), /* eslint-disable-line no-console */
  info: msg => console.info(msg), /* eslint-disable-line no-console */
  warn: msg => console.warn(msg), /* eslint-disable-line no-console */
  error: msg => console.error(msg) /* eslint-disable-line no-console */
}
const _listeners = {
  [Level.Debug]: onDebug,
  [Level.Info]: onInfo,
  [Level.Warn]: onWarn,
  [Level.Error]: onError
}

let _enabled = false
let _logger = _defaultLogger

function processMsg (msg) {
  return typeof msg === 'function' ? msg() : msg
}

function withNoop (fn) {
  const store = storage.getStore()

  storage.enterWith({ noop: true })
  fn()
  storage.enterWith(store)
}

function toggleSubscription (enabled) {
  if (enabled) {
    subscribe(_listeners)
  } else {
    unsubscribe(_listeners)
  }
}

function toggle (enabled) {
  if (enabled !== _enabled) {
    toggleSubscription(enabled)
    _enabled = enabled
  }
}

function use (logger) {
  if (logger && logger.debug instanceof Function && logger.error instanceof Function) {
    _logger = logger
  }
}

function reset () {
  _logger = _defaultLogger
  _enabled = false
  toggleSubscription(false)
}

function onError (err) {
  if (_enabled) {
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

    withNoop(() => _logger.error(err))
  }
}

function onWarn (message) {
  if (!_logger.warn) return onDebug(message)
  if (_enabled) {
    withNoop(() => _logger.warn(processMsg(message)))
  }
}

function onInfo (message) {
  if (!_logger.info) return onDebug(message)
  if (_enabled) {
    withNoop(() => _logger.info(processMsg(message)))
  }
}

function onDebug (message) {
  if (_enabled) {
    withNoop(() => _logger.debug(processMsg(message)))
  }
}

module.exports = { use, toggle, reset }
