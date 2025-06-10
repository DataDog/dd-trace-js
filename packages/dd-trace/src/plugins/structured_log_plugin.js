'use strict'

const LogPlugin = require('./log_plugin')

module.exports = class StructuredLogPlugin extends LogPlugin {
  static get structured () {
    return true
  }

  _shouldInjectLogs (config) {
    return config.logInjection === true || config.logInjection === 'structured'
  }
}