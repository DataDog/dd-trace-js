'use strict'

const StructuredLogPlugin = require('../../dd-trace/src/plugins/structured_log_plugin')

class PinoPlugin extends StructuredLogPlugin {
  static get id () {
    return 'pino'
  }
}

module.exports = PinoPlugin
