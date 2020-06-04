'use strict'

/* eslint-disable no-console */

class CompositeLogger {
  constructor (options = {}) {
    this._loggers = options.loggers || []
  }

  debug (message) {
    for (const logger of this._loggers) {
      logger.debug(message)
    }
  }

  warn (message) {
    for (const logger of this._loggers) {
      logger.warn(message)
    }
  }

  error (message) {
    for (const logger of this._loggers) {
      logger.error(message)
    }
  }
}

module.exports = { CompositeLogger }
