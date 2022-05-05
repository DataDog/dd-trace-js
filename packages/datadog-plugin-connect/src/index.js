'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class ConnectPlugin extends RouterPlugin {
  static get name () {
    return 'connect'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:connect:request:handle', ({ req }) => {
      this.setFramework(req, 'connect', this.config)
    })
  }
}

module.exports = ConnectPlugin
