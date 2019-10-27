'use strict'

const memoize = require('lodash.memoize')

const _default = {
  debug: message => console.log(message), /* eslint-disable-line no-console */
  error: err => console.error(err) /* eslint-disable-line no-console */
}

let _logger
let _enabled
let _deprecate

/*
default [error, debug]
from: https://tools.ietf.org/html/rfc5424

  0       Emergency: system is unusable
  1       Alert: action must be taken immediately
  2       Critical: critical conditions
  3       Error: error conditions
  4       Warning: warning conditions
  5       Notice: normal but significant condition
  6       Informational: informational messages
  7       Debug: debug-level messages
*/

let _customLogLevels

const _isLogLevelEnabled = (level) => { return !_customLogLevels || _customLogLevels.indexOf(level) >= 0 }

const _setCustomLogLevels = (customLogLevels) => {
  if (customLogLevels) {
    try {
      if (typeof customLogLevels === 'string') {
        return customLogLevels.toLowerCase().split(',')
      } else if (Array.isArray(customLogLevels)) {
        return customLogLevels.map(level => level.toLowerCase())
      }
    } catch (e) {
      console.warn('customlogLevels option malformed', customLogLevels, e) /* eslint-disable-line no-console */
    }
  }
}

const log = {
  use (logger) {
    if (logger && logger.debug instanceof Function && logger.error instanceof Function) {
      _logger = logger
    }

    return this
  },

  toggle (enabled, customLogLevels) {
    _enabled = enabled

    if (customLogLevels) {
      _customLogLevels = _setCustomLogLevels(customLogLevels)
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
