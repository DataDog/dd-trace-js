'use strict'

const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class BrowserBunyanPlugin extends LogPlugin {
  static get id () {
    return 'browser-bunyan'
  }
}
module.exports = BrowserBunyanPlugin
