'use strict'

const BunyanPlugin = require('../../datadog-plugin-bunyan/src')

class BrowserBunyanPlugin extends BunyanPlugin {
  static id = 'browser-bunyan'
}

module.exports = BrowserBunyanPlugin
