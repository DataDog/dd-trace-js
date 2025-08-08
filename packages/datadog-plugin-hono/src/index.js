'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class HonoPlugin extends RouterPlugin {
  static id = 'hono'

  constructor (...args) {
    super(...args)

    this.addSub('apm:hono:request:handle', ({ req }) => {
      this.setFramework(req, 'hono', this.config)
    })

    this.addSub('apm:hono:request:route', ({ req, route }) => {
      this.setRoute(req, route)
    })

    this.addSub('apm:hono:request:error', ({ req, error }) => {
      this.addError(req, error)
    })
  }
}

module.exports = HonoPlugin
