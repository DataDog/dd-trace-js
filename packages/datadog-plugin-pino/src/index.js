'use strict'

const LogPlugin = require('../../dd-trace/src/plugins/log-plugin')

class PinoPlugin extends LogPlugin {
  static id = 'pino'
}

module.exports = PinoPlugin
