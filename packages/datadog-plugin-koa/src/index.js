'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class KoaPlugin extends RouterPlugin {
  static id = 'koa'
}

module.exports = KoaPlugin
