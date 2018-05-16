'use strict'

const _default = {
  debug: message => console.log(message), /* eslint-disable-line no-console */
  error: err => console.error(err) /* eslint-disable-line no-console */
}

let _logger = _default
let _enabled = false

module.exports = {
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
  }
}
