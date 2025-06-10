'use strict'

const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class WinstonPlugin extends LogPlugin {
  constructor (...args) {
    super(...args)
    this.structured = true
  }

  static get id () {
    return 'winston'
  }
}
module.exports = WinstonPlugin
