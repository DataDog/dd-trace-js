'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')
const web = require('../../dd-trace/src/plugins/util/web')

class KoaPlugin extends RouterPlugin {
  static get name () {
    return 'koa'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:koa:request:handle', ({ req }) => {
      this.setFramework(req, 'koa', this.config)
    })

    this.addSub('apm:koa:request:route', ({ req, route }) => {
      web.setRoute(req, route)
    })
  }
}

module.exports = KoaPlugin
