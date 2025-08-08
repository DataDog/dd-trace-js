'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class KoaPlugin extends RouterPlugin {
  static id = 'koa'

  constructor (...args) {
    super(...args)

    this.addSub('apm:koa:request:handle', ({ req }) => {
      this.setFramework(req, 'koa', this.config)
    })

    this.addSub('apm:koa:request:route', ({ req, route }) => {
      this.setRoute(req, route)
    })
  }
}

module.exports = KoaPlugin
