'use strict'

const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class WinstonPlugin extends LogPlugin {
  static get id () {
    return 'winston'
  }
}
module.exports = WinstonPlugin
