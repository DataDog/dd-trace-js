'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class RestifyPlugin extends RouterPlugin {
  static id = 'restify'

  constructor (...args) {
    super(...args)

    this.addSub('apm:restify:request:handle', ({ req }) => {
      this.setFramework(req, 'restify', this.config)
    })

    this.addSub('apm:restify:request:route', ({ req, route }) => {
      this.setRoute(req, route)
    })
  }

  configure (config) {
    return super.configure({
      ...config,
      middleware: false // not supported
    })
  }
}

module.exports = RestifyPlugin
