'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')
const web = require('../../dd-trace/src/plugins/util/web')

class MicrogatewayCorePlugin extends RouterPlugin {
  static id = 'microgateway-core'

  constructor (...args) {
    super(...args)

    this.addSub('apm:microgateway-core:request:handle', ({ req }) => {
      this.setFramework(req, 'microgateway', this.config)
    })

    this.addSub('apm:microgateway-core:request:route', ({ req, route }) => {
      web.setRoute(req, route)
    })

    this.addSub('apm:microgateway-core:request:error', ({ error }) => {
      this.addError(error)
    })
  }
}

module.exports = MicrogatewayCorePlugin
