'use strict'

const FetchPlugin = require('../../datadog-plugin-fetch/src/index.js')

class UndiciPlugin extends FetchPlugin {
  static id = 'undici'
  static prefix = 'tracing:apm:undici:fetch'
}

module.exports = UndiciPlugin
