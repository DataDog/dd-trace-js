'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')
const web = require('../../dd-trace/src/plugins/util/web')

class RestifyPlugin extends RouterPlugin {
  static get name () {
    return 'restify'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:restify:request:handle', ({ req }) => {
      this.setFramework(req, 'restify', this.config)
    })

    this.addSub('apm:restify:request:route', ({ req, route }) => {
      web.setRoute(req, route)
    })
  }
}

module.exports = RestifyPlugin
