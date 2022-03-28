const RouterPlugin = require('../../datadog-plugin-router/src')

class ExpressMiddlewarePlugin extends RouterPlugin {
  static get name () {
    return 'express'
  }
}

module.exports = ExpressMiddlewarePlugin
