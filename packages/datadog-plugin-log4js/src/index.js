'use strict'

const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class Log4jsPlugin extends LogPlugin {
  static id = 'log4js'
}
module.exports = Log4jsPlugin
