'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class ExpressTracingPlugin extends RouterPlugin {
  static id = 'express'
}

module.exports = ExpressTracingPlugin
