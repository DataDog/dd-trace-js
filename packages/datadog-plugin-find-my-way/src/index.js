'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const web = require('../../dd-trace/src/plugins/util/web')

class FindMyWayPlugin extends Plugin {
  static get name () {
    return 'find-my-way'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:find-my-way:request:route', ({ req, route }) => {
      web.setRoute(req, route)
    })
  }
}

module.exports = FindMyWayPlugin
