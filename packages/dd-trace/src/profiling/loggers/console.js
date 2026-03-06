'use strict'

/* eslint-disable no-console */

// https://en.wikipedia.org/wiki/Syslog#Severity_level
const mapping = {
  error: 3,
  warn: 4,
  info: 6,
  debug: 7,
}

class ConsoleLogger {
  constructor (options = {}) {
    this._level = mapping[options.level] || mapping.error
  }

  debug (message) {
    this.#log('debug', message)
  }

  info (message) {
    this.#log('info', message)
  }

  warn (message) {
    this.#log('warn', message)
  }

  error (message) {
    this.#log('error', message)
  }

  #log (level, message) {
    if (mapping[level] > this._level) return

    console[level](message)
  }
}

module.exports = { ConsoleLogger }
