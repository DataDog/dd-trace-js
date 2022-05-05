'use strict'

const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class PaperplaneLoggerPlugin extends LogPlugin {
  static get name () {
    return 'paperplane'
  }
}

module.exports = PaperplaneLoggerPlugin
