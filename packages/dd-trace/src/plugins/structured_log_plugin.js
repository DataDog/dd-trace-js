'use strict'

const LogPlugin = require('./log_plugin')

module.exports = class StructuredLogPlugin extends LogPlugin {
  _isEnabled (config) {
    return super._isEnabled(config) || (config.enabled && config.logInjection === 'structured')
  }
}
