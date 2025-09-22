'use strict'

const LogPlugin = require('../../dd-trace/src/plugins/log-plugin')

class BunyanPlugin extends LogPlugin {
  static id = 'bunyan'
}
module.exports = BunyanPlugin
