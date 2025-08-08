'use strict'

const WebPlugin = require('../../datadog-plugin-web/src')

class FindMyWayPlugin extends WebPlugin {
  static id = 'find-my-way'

  constructor (...args) {
    super(...args)

    this.addSub('apm:find-my-way:request:route', ({ req, route }) => {
      this.setRoute(req, route)
    })
  }
}

module.exports = FindMyWayPlugin
