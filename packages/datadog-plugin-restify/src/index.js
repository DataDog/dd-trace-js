'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class RestifyPlugin extends RouterPlugin {
  static id = 'restify'

  configure (config) {
    return super.configure({
      ...config,
      middleware: false // not supported
    })
  }
}

module.exports = RestifyPlugin
