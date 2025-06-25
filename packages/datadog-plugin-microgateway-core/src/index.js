'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')
const web = require('../../dd-trace/src/plugins/util/web')

class MicrogatewayCorePlugin extends RouterPlugin {
  static get id () {
    return 'microgateway-core'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:microgateway-core:request:handle', (ctx) => {
      const { req } = ctx
      this.setFramework(req, 'microgateway', this.config)
    })

    this.addSub('apm:microgateway-core:request:route', (ctx) => {
      const { req, route } = ctx
      web.setRoute(req, route)
    })

    this.addSub('apm:microgateway-core:request:error', (ctx) => {
      const { error } = ctx
      this.addError(error)
    })
  }
}

module.exports = MicrogatewayCorePlugin
