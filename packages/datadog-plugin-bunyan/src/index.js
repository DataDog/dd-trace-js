'use strict'

const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class BunyanPlugin extends LogPlugin {
  constructor (...args) {
    super(...args)
    this.structured = true
  }

  static get id () {
    return 'bunyan'
  }
}
module.exports = BunyanPlugin
