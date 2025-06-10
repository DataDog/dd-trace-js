'use strict'

const StructuredLogPlugin = require('../../dd-trace/src/plugins/structured_log_plugin')

class WinstonPlugin extends StructuredLogPlugin {
  static get id () {
    return 'winston'
  }
}
module.exports = WinstonPlugin
