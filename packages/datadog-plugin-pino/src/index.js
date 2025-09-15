'use strict'

const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class PinoPlugin extends LogPlugin {
  static id = 'pino'
}

module.exports = PinoPlugin
