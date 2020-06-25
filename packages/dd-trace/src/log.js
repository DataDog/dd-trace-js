'use strict'

const _default = {
  debug: (...args) => console.log(...args), /* eslint-disable-line no-console */
  info: (...args) => console.error(...args), /* eslint-disable-line no-console */
  warn: (...args) => console.error(...args), /* eslint-disable-line no-console */
  error: (...args) => console.error(...args) /* eslint-disable-line no-console */
}

// based on: https://github.com/trentm/node-bunyan#levels
const _logLevels = {
  'debug': 20,
  'info': 30,
  'warn': 40,
  'error': 50
}

const _defaultLogLevel = 'debug'

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

function processArgs (args) {
  if (typeof args[0] === 'function') {
    args = args[0]()
    return Array.isArray(args) ? args : [args]
  }
  return args
}

const log = {
  _isLogLevelEnabled (level) {
    return _logLevels[level] >= this._logLevel
  },

  use (logger) {
    if (logger && logger.debug instanceof Function && logger.error instanceof Function) {
      this._logger = logger
    }

    return this
  },

  toggle (enabled, logLevel) {
    this._enabled = enabled
    this._logLevel = _checkLogLevel(logLevel)

    return this
  },

  reset () {
    this._logger = _default
    this._enabled = false
    this._deprecate = memoize((code, message) => {
      this._logger.error(message)
      return this
    })
    this._logLevel = _checkLogLevel()

    return this
  },

  debug (...message) {
    if (this._enabled && this._isLogLevelEnabled('debug')) {
      this._logger.debug(...processArgs(message))
    }

    return this
  },

  info (...message) {
    if (this._enabled && this._isLogLevelEnabled('info')) {
      this._logger.info(...processArgs(message))
    }

    return this
  },

  warn (...message) {
    if (this._enabled && this._isLogLevelEnabled('warn')) {
      this._logger.warn(...processArgs(message))
    }

    return this
  },

  error (err) {
    if (this._enabled && this._isLogLevelEnabled('error')) {
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

      this._logger.error(err)
    }

    return this
  },

  deprecate (code, message) {
    return this._deprecate(code, message)
  }
}

log.reset()

module.exports = log
