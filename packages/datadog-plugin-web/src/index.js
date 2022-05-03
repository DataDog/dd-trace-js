'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const web = require('../../dd-trace/src/plugins/util/web')

class WebPlugin extends Plugin {
  static get name () {
    return 'web'
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }

  setFramework (req, name, config) {
    web.setFramework(req, name, config)
  }
}

module.exports = WebPlugin
