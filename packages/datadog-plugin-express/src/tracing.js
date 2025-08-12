'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class ExpressTracingPlugin extends RouterPlugin {
  static id = 'express'

  constructor (...args) {
    super(...args)

    this.addSub('apm:express:request:handle', ({ req }) => {
      this.setFramework(req, 'express', this.config)
    })
  }
}

module.exports = ExpressTracingPlugin
