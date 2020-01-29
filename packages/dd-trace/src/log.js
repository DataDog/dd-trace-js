'use strict'

const _default = {
  debug: message => console.log(message), /* eslint-disable-line no-console */
  error: err => console.error(err) /* eslint-disable-line no-console */
}

// based on: https://github.com/trentm/node-bunyan#levels
const _logLevels = {
  'debug': 20,
  'error': 50
}

const _defaultLogLevel = 'debug'

let _logger
let _enabled
let _deprecate
let _logLevel

const _isLogLevelEnabled = (level) => {
  return _logLevels[level] >= _logLevel
}

const _checkLogLevel = (logLevel) => {
  if (logLevel && typeof logLevel === 'string') {
    return _logLevels[logLevel.toLowerCase().trim()] || _logLevels[_defaultLogLevel]
  }

  return _logLevels[_defaultLogLevel]
}

const memoize = func => {
  const cache = {}
  const memoized = function (key) {
    if (!cache[key]) {
      cache[key] = func.apply(this, arguments)
    }

    return cache[key]
  }

  return memoized
}

const log = {
  use (logger) {
    if (logger && logger.debug instanceof Function && logger.error instanceof Function) {
      _logger = logger
    }

    return this
  },

  toggle (enabled, logLevel) {
    _enabled = enabled
    _logLevel = _checkLogLevel(logLevel)

    return this
  },

  reset () {
    _logger = _default
    _enabled = false
    _deprecate = memoize((code, message) => {
      _logger.error(message)
      return this
    })
    _logLevel = _checkLogLevel()

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
