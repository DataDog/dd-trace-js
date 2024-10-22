'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')
const web = require('../../dd-trace/src/plugins/util/web')

class HonoPlugin extends RouterPlugin {
  static get id () {
    return 'hono'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:hono:request:handle', ({ req }) => {
      this.setFramework(req, 'hono', this.config)
    })

    this.addSub('apm:hono:request:route', ({ req, route }) => {
      web.setRoute(req, route)
    })

    this.addSub('apm:hono:request:error', ({ req, error }) => {
      web.addError(req, error)
    })
  }
}

module.exports = HonoPlugin
