'use strict'

const memoize = require('lodash.memoize')

const _default = {
  debug: message => console.log(message), /* eslint-disable-line no-console */
  error: err => console.error(err) /* eslint-disable-line no-console */
}

const _logLevels = ['trace', 'debug', 'info', 'warn', 'error']

let _logger
let _enabled
let _deprecate
let _logLevel

const _isLogLevelEnabled = (level) => {
  return !_logLevel || _logLevels.indexOf(level) >= _logLevels.indexOf(_logLevel)
}

const _setLogLevel = (logLevel) => {
  if (logLevel && typeof logLevel === 'string') {
    return logLevel.toLowerCase().trim()
  }
}

const log = {
  use (logger) {
    if (logger && logger.debug instanceof Function && logger.error instanceof Function) {
      _logger = logger
    }

    return this
  },

  toggle (enabled, customLogLevel) {
    _enabled = enabled

    if (customLogLevel) {
      _logLevel = _setLogLevel(customLogLevel)
    }

    return this
  },

  reset () {
    _logger = _default
    _enabled = false
    _deprecate = memoize((code, message) => {
      _logger.error(message)
      return this
    })
    _logLevel = undefined

    return this
  },

  debug (message) {
    if (_enabled && _isLogLevelEnabled('debug')) {
      _logger.debug(message instanceof Function ? message() : message)
    }

    return this
  },

  error (err) {
    if (_enabled && _isLogLevelEnabled('error')) {
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

      _logger.error(err)
    }

    return this
  },

  deprecate (code, message) {
    return _deprecate(code, message)
  }
}

log.reset()

module.exports = log
