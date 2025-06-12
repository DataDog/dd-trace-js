'use strict'

const StructuredLogPlugin = require('../../dd-trace/src/plugins/structured_log_plugin')

class WinstonPlugin extends StructuredLogPlugin {
  static get id () {
    return 'winston'
  }

  // winston can send both structured (i.e. JSON) and unstructured logs
  static get _structured () {
    return 'mixed'
  }
}
module.exports = WinstonPlugin
