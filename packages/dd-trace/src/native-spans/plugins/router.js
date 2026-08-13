'use strict'

const { MIDDLEWARE_ROUTER } = require('../wire')
const NativeMiddlewarePlugin = require('./middleware')

/**
 * Stands in for `datadog-plugin-router` when native plugins are on.
 */
class NativeRouterPlugin extends NativeMiddlewarePlugin {
  static id = 'router'

  constructor () {
    super('router', MIDDLEWARE_ROUTER)
  }
}

module.exports = NativeRouterPlugin
