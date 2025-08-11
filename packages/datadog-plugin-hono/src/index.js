'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class HonoPlugin extends RouterPlugin {
  static id = 'hono'
}

module.exports = HonoPlugin
