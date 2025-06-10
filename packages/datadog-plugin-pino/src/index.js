'use strict'

const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class PinoPlugin extends LogPlugin {
  constructor (...args) {
    super(...args)
    this.structured = true
  }

  static get id () {
    return 'pino'
  }
}

module.exports = PinoPlugin
