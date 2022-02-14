'use strict'

const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class PinoPlugin extends LogPlugin {
  static get name () {
    return 'pino'
  }
}

module.exports = PinoPlugin
