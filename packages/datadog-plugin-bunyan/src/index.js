'use strict'

const StructuredLogPlugin = require('../../dd-trace/src/plugins/structured_log_plugin')

class BunyanPlugin extends StructuredLogPlugin {
  static get id () {
    return 'bunyan'
  }
}
module.exports = BunyanPlugin
