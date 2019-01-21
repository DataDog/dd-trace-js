'use strict'

const memoize = require('lodash.memoize')

const _default = {
  debug: message => console.log(message), /* eslint-disable-line no-console */
  error: err => console.error(err) /* eslint-disable-line no-console */
}

let _logger
let _enabled
let _deprecate

const log = {
  use (logger) {
    if (logger && logger.debug instanceof Function && logger.error instanceof Function) {
      _logger = logger
    }

    return this
  },

  toggle (enabled) {
    _enabled = enabled

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
    if (_enabled) {
      _logger.debug(message instanceof Function ? message() : message)
    }

    return this
  },

  error (err) {
    if (_enabled) {
      if (err instanceof Function) {
        err = err()
      }

      _logger.error(typeof err === 'string' ? new Error(err) : err)
    }

    return this
  },

  deprecate (code, message) {
    return _deprecate(code, message)
  }
}

log.reset()

module.exports = log
