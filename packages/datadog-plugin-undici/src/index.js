'use strict'

const FetchPlugin = require('../../datadog-plugin-fetch/src/index.js')

class UndiciPlugin extends FetchPlugin {
  static get id () { return 'undici' }
  static get prefix () {
    return 'tracing:apm:undici:fetch'
  }
}

module.exports = UndiciPlugin
