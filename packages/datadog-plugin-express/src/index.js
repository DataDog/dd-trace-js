'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class ExpressPlugin extends RouterPlugin {
  static get id () {
    return 'express'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:express:request:handle', ({ req }) => {
      this.setFramework(req, 'express', this.config)
    })
  }
}

module.exports = ExpressPlugin
