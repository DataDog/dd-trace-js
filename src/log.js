'use strict'

let _logger = {
  debug: () => {},
  error: () => {}
}

module.exports = {
  use (logger) {
    const isObject = logger && typeof logger === 'object'

    if (isObject && logger.debug instanceof Function && logger.error instanceof Function) {
      _logger = logger
    }
  },

  debug (message) {
    _logger.debug(message)
  },

  error (message) {
    _logger.error(message)
  }
}
