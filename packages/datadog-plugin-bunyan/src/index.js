'use strict'

const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class BunyanPlugin extends LogPlugin {
  static get name () {
    return 'bunyan'
  }
}
module.exports = BunyanPlugin
