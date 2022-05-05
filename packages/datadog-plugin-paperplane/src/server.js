'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')
const web = require('../../dd-trace/src/plugins/util/web')

class PaperplaneServerPlugin extends RouterPlugin {
  static get name () {
    return 'paperplane'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:paperplane:request:handle', req => {
      this.setFramework(req, 'paperplane', this.config)
    })

    this.addSub('apm:paperplane:request:route', ({ req, route }) => {
      web.setRoute(req, route)
    })
  }
}

module.exports = PaperplaneServerPlugin
